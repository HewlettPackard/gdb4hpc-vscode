// Copyright 2024 Hewlett Packard Enterprise Development LP.

import {DebugProtocol} from '@vscode/debugprotocol';
import { InitializedEvent, LoggingDebugSession, OutputEvent, Scope, Handles, 
  StoppedEvent,InvalidatedEvent,TerminatedEvent,Thread, Variable} from '@vscode/debugadapter';
import { Subject } from 'await-notify';
import { continue_cmd, next_cmd, pause_cmd, stepIn_cmd, stepOut_cmd, setBreakpoints, terminate_cmd,on_cmd,
  getThreads, stack, getVariables, spawn, launchApp, sendCommand, isStarted, writeToPty, getVariable } from './extension';
import { DbgVar } from './GDB4HPC';
import * as vscode from 'vscode';

export interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  program: string;
  args?: string;
  cwd: string;
  apps: any[];
  name: string;
  setupCommands: string[];
  env: any;
  request: any;
}

export class DebugSession extends LoggingDebugSession {
  private _configurationDone = new Subject();
  private _variableHandles = new Handles<'locals'>
  //corresponding number to vscode session
  name: string;
  num: number;
  currentLine:number
  currentFile:string

  constructor(name: string, num: number) {
    super();
    this.name = name;
    this.num = num;
  }

  protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) {
    const refreshFocusEvent = { event: "refreshFocus"} as DebugProtocol.Event;

    //only let one debug console print output
    if (this.num == 0){
      on_cmd('output', (text) => {
        const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`, 'console');
        this.sendEvent(e);
      });
    }

    on_cmd('breakpoint-hit', (threadID:any) => {
      this.sendEvent(new InvalidatedEvent(['variables']));
      this.sendEvent(new StoppedEvent('breakpoint',threadID));
      this.sendEvent(refreshFocusEvent);
    });

    on_cmd('end-stepping-range', (threadID: number) => {
      this.sendEvent(new StoppedEvent('step', threadID));
      this.sendEvent(refreshFocusEvent);
    });

    on_cmd('exited-normally', () => {
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
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
    terminate_cmd().then(() => {
      this.sendResponse(response);
    });
  }

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		this._configurationDone.notify();
	}

  protected async launchRequest( response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
    await this._configurationDone.wait(1000);
    if(!vscode.debug.activeDebugSession)spawn(args);
    launchApp(this.num).then(()=>{
      this.sendResponse(response);
    });
  }

  protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
    setBreakpoints(args.source.path || '', args.breakpoints || []).then(() => {
      this.sendResponse(response);
    });
  }

  protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		stack(startFrame, endFrame,args.threadId,this.name).then((stack: DebugProtocol.StackFrame[]) => {
      response.body = {stackFrames: stack, totalFrames: stack.length};
      this.sendResponse(response);
    });
		
	}

  protected scopesRequest(response: DebugProtocol.ScopesResponse,args: DebugProtocol.ScopesArguments): void {
    response.body = {
      scopes: [new Scope("Locals", this._variableHandles.create('locals'), false)]
    };
    this.sendResponse(response);
  }

  protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) {
    getVariables().then((vars: DbgVar[]) => {
      let variables: Variable[] = [];
      let filtered=[...vars];
      filtered.forEach((variable)=>{
        variable.values = variable.values.filter((item)=>item.procset==this.name);
      })
      filtered.forEach(variable => {
        variables = [...variables,...this.convertVariable(variable)??[]];
      });
      response.body = {
        variables: variables,
      };

      this.sendResponse(response);
    });
  }

  //Converts variable to the debug adapter variable
  private convertVariable(variable: DbgVar): Variable[]{
    const variables: Variable[] = [];
    if (variable){
      variable.values.forEach(val => {
        if (typeof val.value === 'string' && val.value) {
          val.value = val.value.replace(/\\r/g, ' ').replace(/\\t/g, '\t').replace(/\\v/g, '\v').replace(/\\"/g, '"')
                                    .replace(/\\'/g, "'").replace(/\\\\/g, '\\').replace(/\\n/g, ' ');
        }

        if(val.value){
          let name = variable.name+"("+val.procset+"{"+val.group+"})"
          const v: DebugProtocol.Variable = new Variable(name, val.value, variable.childNum ? variable.referenceID : 0, variable.referenceID);
          v.variablesReference = variable.referenceID;
          v.type = variable.type;
          variables.push(v);
        }
      });
    }
    return variables;
  }

  protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
    next_cmd().then(() => {  
      this.sendResponse(response);
    });
  }

  protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
    stepIn_cmd().then(() => {
      this.sendResponse(response);
    });
  }

  protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepInArguments): void {
    stepOut_cmd().then(() => {
      this.sendResponse(response);
    });
  }
  
  protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
    continue_cmd().then(() => {
      this.sendResponse(response);
    });
  }

  protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
    pause_cmd().then(() => {
      this.sendResponse(response)
    });
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
      getThreads().then((threads:Map<string,any[]>) => {
        let sessionThreads = threads.get(this.name)
        if(sessionThreads){
          let resultThreads:Thread[] = []
          sessionThreads.forEach((thread)=>{
            resultThreads.push(new Thread(thread.id, thread.name));
            
          });
          response.body = {
            threads:  resultThreads,
          };
        }
        this.sendResponse(response);
      });
  }
  
  protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
    switch (args.context) {
      case 'watch':
      case 'hover': {
        let new_var = getVariable(args.expression);
        new_var?new_var.values = new_var.values.filter((item)=>item.procset==this.name):null;
        let variable_array = new_var?this.convertVariable(new_var):[];
        variable_array!.forEach(variable =>  {
          response.body = {
            result: variable!.value?variable!.value:'',
            variablesReference: variable!.variablesReference,
          };

          if (!variable!.value) {
            response.success = false;
            response.message = `Variable not found`;
          }
        });
        //FIX (PE-53410): only sending first rank available back for now as only one reply is able to be sent
        this.sendResponse(response);
        break;
      }
      case 'repl': {
        if(!isStarted()){
          writeToPty(args.expression);
          break;
        }
        // this is where text entered in the debug console ends up. send the command to gdb4hpc.
        sendCommand(args.expression);
        // no need to catch the output, console output events will automatically be caught and routed
        break;
      }
    }
  }

  public getNumber():number{
    return this.num;
  }
}
