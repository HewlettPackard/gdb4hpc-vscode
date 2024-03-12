// Copyright 2024 Hewlett Packard Enterprise Development LP.

import {DebugProtocol} from '@vscode/debugprotocol';
import {
  ContinuedEvent, InitializedEvent, LoggingDebugSession, OutputEvent, Scope, Handles,
  StackFrame,StoppedEvent,InvalidatedEvent,TerminatedEvent,Thread, Variable
} from '@vscode/debugadapter';
import { Subject } from 'await-notify';
import { GDB4HPC } from './GDB4HPC';

export interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  program: string;
  args?: string;
  cwd: string;
  apps: any[];
  name: string;
  dbgversion:string;
  env: any;
  request: any;
}

export class DebugSession extends LoggingDebugSession {
  public _debugger: GDB4HPC;
  private _configurationDone = new Subject();
  private _variableHandles = new Handles<'locals'>

  protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) {

    this._debugger = new GDB4HPC();
    this.bindDebuggerEvents();

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
    this._debugger.terminate().then(() => {
      this.sendResponse(response);
    });
  }

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		this._configurationDone.notify();
	}

  protected async launchRequest( response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
    await this._configurationDone.wait(1000);
    this._debugger.spawn(args);
    this.sendResponse(response);
  }

  protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
    this._debugger.setBreakpoints(args.source.path || '', args.breakpoints || []).then(() => {
      this.sendResponse(response);
    });
  }

  protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		this._debugger.stack(startFrame, endFrame).then((stack: StackFrame[]) => {
      response.body = {stackFrames: stack, totalFrames: stack.length};
      this.sendResponse(response);
    });
		
	}

  protected scopesRequest(response: DebugProtocol.ScopesResponse,args: DebugProtocol.ScopesArguments): void {
    response.body = {
      scopes: [new Scope("Locals", this._variableHandles.create('locals'), false)],
    };
    this.sendResponse(response);
  }

  protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) {
    this._debugger.getVariables().then((vars: Variable[]) => {
      response.body = {
        variables: vars,
      };

      this.sendResponse(response);
    });
  }

  protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
    this._debugger.next().then(() => { 
      this.sendResponse(response);
    });
  }

  protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
    this._debugger.stepIn().then(() => {
      this.sendResponse(response);
    });
  }

  protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
    this._debugger.continue().then(() => {
      this.sendResponse(response);
    });
  }

  protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
    this._debugger.pause().then(() => {
      this.sendResponse(response)
    });
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    this._debugger.getThreads().then((threads: Thread[]) => {
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
        let variable_array = this._debugger.getVariable(args.expression);

        variable_array!.forEach(variable =>  {
          response.body = {
            result: variable!.value?variable!.value:'',
            variablesReference: variable!.variablesReference,
          };

          if (!variable!.value) {
            response.success = false;
            response.message = `Variable '${variable!.name}' not found`;
          }
          this.sendResponse(response);
        });

      }
    }
  }

  private bindDebuggerEvents(): void {
    const changeFocusEvent = { event: "changeFocus", body: ["all"] } as DebugProtocol.Event;
    const refreshPeEvent = { event: "refreshPeEvent", body: [""] } as DebugProtocol.Event;
    this._debugger.on('output', (text) => {
      const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`, 'console');
      this.sendEvent(e);
    });

    this._debugger.on('running', (threadID: number, allThreads: boolean) => {
      this.sendEvent(new ContinuedEvent(threadID, allThreads));
    });

    this._debugger.on('breakpoint-hit', (threadID: number) => {
      this.sendEvent(new InvalidatedEvent(['variables']));
      this.sendEvent(new StoppedEvent('breakpoint', threadID));
      this.sendEvent(refreshPeEvent);
    });

    this._debugger.on('entry', (threadID: number) => {
      this.sendEvent(new StoppedEvent('entry',threadID));
      this.sendEvent(refreshPeEvent);
      this.sendEvent(changeFocusEvent);
    });

    this._debugger.on('end-stepping-range', (threadID: number) => {
      this.sendEvent(new StoppedEvent('step', threadID));
      this.sendEvent(refreshPeEvent);
    });

    this._debugger.on('exited-normally', () => {
      this.sendEvent(new TerminatedEvent());
    });
  }
}
