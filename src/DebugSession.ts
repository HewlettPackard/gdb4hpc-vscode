// Copyright 2024 Hewlett Packard Enterprise Development LP.

import {DebugProtocol} from '@vscode/debugprotocol';
import { InitializedEvent, LoggingDebugSession, OutputEvent, Scope, Handles,
  StackFrame,StoppedEvent,InvalidatedEvent,TerminatedEvent,Thread, Variable} from '@vscode/debugadapter';
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
  public gdb4hpc: GDB4HPC;
  private _configurationDone = new Subject();
  private _variableHandles = new Handles<'locals'>

  protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) {

    this.gdb4hpc = new GDB4HPC();
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
    this.gdb4hpc.terminate().then(() => {
      this.sendResponse(response);
    });
  }

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		this._configurationDone.notify();
	}

  protected async launchRequest( response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {
    await this._configurationDone.wait(1000);
    this.gdb4hpc.spawn(args);
    this.sendResponse(response);
  }

  protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
    this.gdb4hpc.setBreakpoints(args.source.path || '', args.breakpoints || []).then(() => {
      this.sendResponse(response);
    });
  }

  protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		const startFrame = typeof args.startFrame === 'number' ? args.startFrame : 0;
		const maxLevels = typeof args.levels === 'number' ? args.levels : 1000;
		const endFrame = startFrame + maxLevels;

		this.gdb4hpc.stack(startFrame, endFrame).then((stack: StackFrame[]) => {
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
    this.gdb4hpc.getVariables().then((vars: Variable[]) => {
      response.body = {
        variables: vars,
      };

      this.sendResponse(response);
    });
  }

  protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
    this.gdb4hpc.next().then(() => {  
      this.sendResponse(response);
    });
  }

  protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
    this.gdb4hpc.stepIn().then(() => {
      this.sendResponse(response);
    });
  }

  protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
    this.gdb4hpc.continue().then(() => {
      this.sendResponse(response);
    });
  }

  protected pauseRequest(response: DebugProtocol.PauseResponse, args: DebugProtocol.PauseArguments): void {
    this.gdb4hpc.pause().then(() => {
      this.sendResponse(response)
    });
  }

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    this.gdb4hpc.getThreads().then((threads: Thread[]) => {
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
        let variable_array = this.gdb4hpc.getVariable(args.expression);

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
      }
    }
  }

  private bindDebuggerEvents(): void {
    this.gdb4hpc.on('output', (text) => {
      const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`, 'console');
      this.sendEvent(e);
    });

    this.gdb4hpc.on('breakpoint-hit', (threadID: number) => {
      this.sendEvent(new InvalidatedEvent(['variables']));
      this.sendEvent(new StoppedEvent('breakpoint', threadID));
    });

    this.gdb4hpc.on('end-stepping-range', (threadID: number) => {
      this.sendEvent(new StoppedEvent('step', threadID));
    });

    this.gdb4hpc.on('exited-normally', () => {
      this.sendEvent(new TerminatedEvent());
    });
  }
}
