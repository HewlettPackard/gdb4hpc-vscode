// Copyright 2024-2025 Hewlett Packard Enterprise Development LP.

import {DebugProtocol} from '@vscode/debugprotocol';
import { InitializedEvent, LoggingDebugSession, OutputEvent, Handles, StoppedEvent,InvalidatedEvent,
  TerminatedEvent} from '@vscode/debugadapter';
import { Subject } from 'await-notify';
import { continue_cmd, next_cmd, pause_cmd, stepIn_cmd, stepOut_cmd, setBreakpoints, terminate_cmd,on_cmd,
  getThreads, stack, getVariables, spawn, launchApp, sendCommand, evaluateVariable} from './extension';
import * as vscode from 'vscode';

export interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  program: string;
  args?: string;
  cwd: string;
  apps: any[];
  name: string;
  setupCommands: string[];
  connConfig: any;
  env: any;
  request: any;
}

export class DebugSession extends LoggingDebugSession {
  private _configurationDone = new Subject();
  private _variableHandles = new Handles<'locals'>
  
  //information for the DebugSession instance
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

  //launch gdb4hpc if nothing is active, otherwise launch an application
  protected launchRequest( response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
    if(!vscode.debug.activeDebugSession){
      spawn(args).then(()=>{
        launchApp(this.num).then(()=>{
          this.sendResponse(response);
        });
      })
    }else{
      launchApp(this.num).then(()=>{
        this.sendResponse(response);
      });
    }
  }

  protected async sourceRequest(response: DebugProtocol.SourceResponse, args: DebugProtocol.SourceArguments, request?: DebugProtocol.Request): Promise<void> {
    this.sendResponse(response)
  }
  
  protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
    setBreakpoints(args.source.path || '', args.breakpoints || []).then((res) => {
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

		stack(startFrame, endFrame,args.threadId,this.name).then((stack: DebugProtocol.StackFrame[]) => {
      response.body = {stackFrames: stack, totalFrames: stack.length};
      this.sendResponse(response);
    });
	}

  protected scopesRequest(response: DebugProtocol.ScopesResponse,args: DebugProtocol.ScopesArguments): void {
    response.body = {
      scopes: [{name:"Locals",variablesReference:this._variableHandles.create('locals'),expensive:false}]
    };
    this.sendResponse(response);
  }

  protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) {
    getVariables(this.name).then((variables) => {
      response.body = {
        variables: variables,
      };
      this.sendResponse(response);
    });
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
    getThreads(this.name).then((threads:DebugProtocol.Thread[]) => {
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
        evaluateVariable(this.name,args.expression).then((variable)=>{
          response.body = {
            result: variable.value?variable!.value:'',
            variablesReference: variable.variablesReference,
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
        sendCommand(args.expression);
        // no need to catch the output, console output events will automatically be caught and routed
        break;
      }
    }
  }
}
