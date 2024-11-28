// Copyright 2024 Hewlett Packard Enterprise Development LP.

import {DebugProtocol} from '@vscode/debugprotocol';
import { InitializedEvent, LoggingDebugSession, OutputEvent, Scope, Handles,
  StackFrame,StoppedEvent,InvalidatedEvent,TerminatedEvent,Thread, Variable} from '@vscode/debugadapter';
import { Subject } from 'await-notify';
import { debugSessions, gdb4hpc } from './extension';
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

  protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) {
    let e=vscode.debug.activeDebugSession
    if(!e){
      const refreshFocusEvent = { event: "refreshFocus"} as DebugProtocol.Event;
      const newAppEvent = { event: "newApp"} as DebugProtocol.Event;

      gdb4hpc.on('newApp', (app)=> {
        console.log("newApp:", app)
        if (app){
          newAppEvent.body = app;
        }
        this.sendEvent(newAppEvent);
        
      });
      
      gdb4hpc.on('output', (text) => {
        const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`, 'console');
        this.sendEvent(e);
      });

      gdb4hpc.on('breakpoint-hit', (threadID: number) => {
        this.sendEvent(new InvalidatedEvent(['variables']));
        this.sendEvent(new StoppedEvent('breakpoint', threadID));
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
    }
    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments): void {
    gdb4hpc.terminate().then(() => {
      this.sendResponse(response);
    });
  }

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		this._configurationDone.notify();
	}

  protected async launchRequest( response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
    await this._configurationDone.wait(1000);
    if(!vscode.debug.activeDebugSession)gdb4hpc.spawn(args);
    this.sendResponse(response);
  }

  protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
    gdb4hpc.setBreakpoints(args.source.path || '', args.breakpoints || []).then(() => {
      this.sendResponse(response);
    });
  }

  protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		gdb4hpc.stack(startFrame, endFrame).then((stack: StackFrame[]) => {
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
    gdb4hpc.getVariables().then((vars: Variable[]) => {
      response.body = {
        variables: vars,
      };

      this.sendResponse(response);
    });
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
    gdb4hpc.getThreads().then((threads: Thread[]) => {
      response.body = {
        threads: threads,
      };
      this.sendResponse(response);
    });
  }
  
  protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
    switch (args.context) {
      case 'watch':
      case 'hover': {
        let variable_array = gdb4hpc.getVariable(args.expression);

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
        if(!gdb4hpc.isStarted()){
          gdb4hpc.writeToPty(args.expression);
          break;
        }
        // this is where text entered in the debug console ends up. send the command to gdb4hpc.
        gdb4hpc.sendCommand(args.expression);
        // no need to catch the output, console output events will automatically be caught and routed
        break;
      }
    }
  }
}
