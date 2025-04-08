// Copyright 2024-2025 Hewlett Packard Enterprise Development LP.

import {DebugProtocol} from '@vscode/debugprotocol';
import { InitializedEvent, LoggingDebugSession, OutputEvent, Handles, StoppedEvent,InvalidatedEvent,
TerminatedEvent} from '@vscode/debugadapter';
import { Subject } from 'await-notify';
import { GDB4HPC } from './GDB4HPC';
import * as vscode from 'vscode';

export interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  program: string;
  args?: string;
  cwd: string;
  apps: any[];
  setupCommands: string[];
  connConfig: any;
  env: any;
  request: any;
}

let gdb4hpc=new GDB4HPC();

export class DebugSession extends LoggingDebugSession {
  private _configurationDone = new Subject();
  private varHandles= new Handles<{name:string, app:string}>()
  private handleMap = new Map<string,number>();
  private scopes:DebugProtocol.Scope[]=[]
  
  //information for the DebugSession instance

  constructor() {
    super();
  }

  protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) {
    const refreshFocusEvent = { event: "refreshFocus"} as DebugProtocol.Event;

    gdb4hpc.on('output', (text) => {
      const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`, 'console');
      this.sendEvent(e);
    });

    gdb4hpc.on('breakpoint-hit', (threadID:any) => {
      this.sendEvent(new InvalidatedEvent(['variables']));
      this.sendEvent(new StoppedEvent('breakpoint',threadID));
      this.sendEvent(refreshFocusEvent);
    });

    gdb4hpc.on('end-stepping-range', (threadID: number) => {
      this.sendEvent(new StoppedEvent('step', threadID));
      this.sendEvent(refreshFocusEvent);
    });

    gdb4hpc.on('exited-normally', () => {
      this.sendEvent(new TerminatedEvent());
    });

    response.body = response.body || {};
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsEvaluateForHovers = true;
    response.body.supportsCompletionsRequest = true;
    response.body.supportsStepBack = false;
    response.body.supportsSteppingGranularity = true;
    response.body.supportsLogPoints = true;
    response.body.supportsGotoTargetsRequest = true;
    response.body.supportsFunctionBreakpoints = true;
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
    gdb4hpc.conn.removeFiles()
    gdb4hpc.terminate().then(() => {
      this.sendEvent(new TerminatedEvent());
      this.sendResponse(response);
    });
  }

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		this._configurationDone.notify();
	}

  //launch gdb4hpc if nothing is active, otherwise launch an application
  protected launchRequest( response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
    gdb4hpc.spawn(args).then(()=>{
      gdb4hpc.launchApps().then(()=>{
        this.sendResponse(response);
      });
    })
  }

  protected async sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request): Promise<void> {
    let localPath =args.source?.name;
    if (!localPath) return;
    let remotePath=localPath;

    if (gdb4hpc.dataStore.getStatus("remote")) {
      localPath=gdb4hpc.dataStore.convertSourceFilePath(false,remotePath)
      if(localPath!.length==0){
        await gdb4hpc.conn.getFileSFTP(remotePath).then((path)=>{
          if(path.length==0){
            this.sendErrorResponse(response, 1001, "No file")
            return;
          }
          localPath=path
          gdb4hpc.dataStore.addSourceFile(remotePath,localPath!);
        },(err)=>{
          this.sendErrorResponse(response, 1002, "Error retrieving file from remote server")
        }); 
      }
    }

    // Check if the file is already open in the editor
    let openDocument = vscode.workspace.textDocuments.find(doc => doc.uri.fsPath.includes(localPath!));
    if (!openDocument){
      openDocument = await vscode.workspace.openTextDocument(vscode.Uri.file(localPath!));
    }
    let content = openDocument.getText();

    response.body = {
      content: content
    };
    this.sendResponse(response);
  }

  /*
   * Note that this function actually only deals with filename:linenum breakpoints
   */
  protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
    gdb4hpc.setSourceBreakpoints(args.source.path || '', args.breakpoints || []).then((res) => {
      response.body = {
        breakpoints: res
      }
      this.sendResponse(response);
    });
  }

  protected setFunctionBreakPointsRequest(response: DebugProtocol.SetFunctionBreakpointsResponse, args: DebugProtocol.SetFunctionBreakpointsArguments, request?: DebugProtocol.Request): void {
    gdb4hpc.setFunctionBreakpoints(args.breakpoints).then((res) => {
      response.body = {
        breakpoints: res
      }
      this.sendResponse(response);
    });
  }

  protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		gdb4hpc.stack(startFrame, endFrame,args.threadId).then((stack: DebugProtocol.StackFrame[]) => {
      response.body = {stackFrames: stack, totalFrames: stack.length};
      this.sendResponse(response);
    });
	}

  protected scopesRequest(response: DebugProtocol.ScopesResponse,args: DebugProtocol.ScopesArguments): void {

    gdb4hpc.apps.forEach((app)=>{
      if(!this.scopes.find((scope)=>scope.name==app.name)){
        let handle = this.varHandles.create({name:app.name,app:app.name})
        this.handleMap.set(app.name,handle)
        this.scopes.push({name:app.name,variablesReference:handle,expensive:false})
      }
    })
    response.body = {
      scopes: this.scopes
    };
    this.sendResponse(response);
  }

  protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) {
    let handle = this.varHandles.get(args.variablesReference)
    let vars:DebugProtocol.Variable[]=[]
    gdb4hpc.getVariables().then((vs) => {
      let app = gdb4hpc.apps.find((app)=>app.name==handle.name)
      if(app){
        let variables = vs.map((item)=>item.value)
        variables.forEach((variable)=>{
          let vRef = this.handleMap.get(variable.name)
          if(!vRef){
            vRef = this.varHandles.create({name:variable.name,app:app.name})
            this.handleMap.set(variable.name,vRef)
          }
          if(!vars.find((v)=>v.variablesReference==vRef)) vars.push({name:variable.name,variablesReference:vRef,value:""})
        })
      }else{
        let filtered = vs.filter((va)=>va.value.name==handle.name && va.app==handle.app)
        vars = filtered.map((va)=>({...va.value, name:gdb4hpc.rangeToString(va.group)}))
      }
      response.body = {
        variables: vars
      };
      this.sendResponse(response);
    })
    
  }

  protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
    gdb4hpc.next().then(() => {  
      this.sendResponse(response);
    });
  }

  protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
    gdb4hpc.stepIn().then(() => {
      this.sendResponse(response);
    });
  }

  protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepInArguments): void {
    gdb4hpc.stepOut().then(() => {
      this.sendResponse(response);
    });
  }
  
  protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
    gdb4hpc.continue().then(() => {
      this.sendResponse(response);
    });
  }

  protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
    gdb4hpc.pause().then(() => {
      this.sendResponse(response)
    });
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    gdb4hpc.getThreads().then((threads:DebugProtocol.Thread[]) => {
      response.body = {
        threads:  threads,
      };
      this.sendResponse(response);
    });
  }
  
  protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
    switch (args.context) {
      case 'watch':
      case 'hover': {
        gdb4hpc.evaluateVariable(args.expression).then((variable)=>{
          response.body = {
            result: variable.value?variable!.value:'',
            variablesReference: variable.variableReference,
          };

          if (!variable.value) {
            response.success = false;
            response.message = `Variable not found`;
          }
          this.sendResponse(response);
        });
        break;
      }
      case 'repl': {
        // this is where text entered in the debug console ends up. send the command to gdb4hpc.
        gdb4hpc.sendCommand(args.expression);
        // no need to catch the output, console output events will automatically be caught and routed
        break;
      }
    }
  }
}

export function setGroupFilter(group: string){
  return gdb4hpc.setGroupFilter(group)
}

export function setStatus(status:string, value:any){
  return gdb4hpc.setStatus(status,value);
}

export function getStatus(status:string):any{
  return gdb4hpc.getStatus(status);
}

export function runAssertScript(assertion: any){
  return gdb4hpc.runAssertionScript(assertion)
}

export function getAssertResults(assertion: any){
  return gdb4hpc.getAssertionResults(assertion)
}

export function buildAssertScript(new_script: any){
  return gdb4hpc.buildAssertionScript(new_script)
}

export function buildDecomposition(decomp_cmds: any){
  return gdb4hpc.buildDecomposition(decomp_cmds)
}

export function runCompare(){
  return gdb4hpc.runComparisons()
}

export function changeFocus(procset){
  return gdb4hpc.changeFocus(procset)
}

export function addProcset(name, procset){
  return gdb4hpc.addProcset(name,procset)
}

export function getProcsetList(){
  return gdb4hpc.getProcsetList()
}

