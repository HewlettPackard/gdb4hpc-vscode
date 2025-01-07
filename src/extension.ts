// Copyright 2024 Hewlett Packard Enterprise Development LP.

'use strict';

import * as vscode from 'vscode';
import { WorkspaceFolder,DebugConfiguration,CancellationToken,ProviderResult} from 'vscode';
import { DebugSession } from './DebugSession';
import { FocusProvider} from './FocusProvider';
import { CompareProvider } from './CompareProvider';
import { AssertionProvider } from './AssertionProvider';
import { DecompositionProvider } from './DecompostionProvider';
import { GDB4HPC } from './GDB4HPC';

export let gdb4hpc=new GDB4HPC;

class GDB4HPCConfigurationProvider implements vscode.DebugConfigurationProvider {

  public apps: any;
  /**
   * Massage a debug configuration just before a debug session is being launched,
   * e.g. add all missing attributes to the debug configuration.
   */
  resolveDebugConfiguration(folder: WorkspaceFolder | undefined, config: DebugConfiguration, token?: CancellationToken): ProviderResult<DebugConfiguration> {
    // if launch.json is missing or empty
    if (!config.type && !config.request && !config.name) {
      const editor = vscode.window.activeTextEditor;
      
      if (editor && (editor.document.languageId === 'cpp' || editor.document.languageId === 'c')) {
        config.type = 'gdb4hpc';
        config.name = 'Launch GDB4HPC';
        config.request = 'launch';
        config.stopOnEntry = true;
      }
    }

    if (!config.apps){
			return vscode.window.showInformationMessage("Cannot find a program to debug").then(_ => {
				return undefined;	// abort launch
			});
    }else{
      if(count<config.apps.length){
        app=config.apps[count]
        config.name = config.apps[count].name
        return config;
      }
    }
  }
}

export let debugSessions:vscode.DebugSession[] = [];
export let app:any;
export let count = 0;

export function activate(context: vscode.ExtensionContext) {
  const provider = new GDB4HPCConfigurationProvider();
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('gdb4hpc', provider));
  let factory = new InlineDebugAdapterFactory();
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('gdb4hpc', factory));
  context.subscriptions.push(vscode.commands.registerCommand('getContext', () => context));

  //Add Focus Panel to sidebar
  let focusProvider = new FocusProvider(context.extensionUri);
  vscode.window.registerWebviewViewProvider('focusView', focusProvider);

  //Add decomposition panel to sidebar
  let decompositionProvider = new DecompositionProvider(context.extensionUri);
  vscode.window.registerWebviewViewProvider("decompView", decompositionProvider);
  vscode.commands.registerCommand('decompView.addEntry', () => {decompositionProvider.addDecomposition()});

  //Add comparison panel to sidebar
  let compareProvider = new CompareProvider(context.extensionUri);
  vscode.window.registerWebviewViewProvider("compareView", compareProvider);
  vscode.commands.registerCommand('compareView.runCompares', () => {compareProvider.runComparisons()});
  vscode.commands.registerCommand('compareView.addEntry', () => {compareProvider.addComparison();});

  //Add assertion panel to sidebar
  let assertionProvider = new AssertionProvider(context.extensionUri);
  vscode.window.registerWebviewViewProvider("assertView", assertionProvider);
  vscode.commands.registerCommand('assertView.runScripts', () => {assertionProvider.runAssertionScript()});
  vscode.commands.registerCommand('assertView.getInfo', () => {assertionProvider.getAssertionResults()});
  vscode.commands.registerCommand('assertView.addEntry', () => {assertionProvider.addAssertionScript()});

  //get events from providers
  context.subscriptions.push(vscode.debug.onDidReceiveDebugSessionCustomEvent((e) => {
    if(e.event == "refreshFocus"){
      focusProvider.refresh();
    }
  })); 
  
  vscode.debug.onDidStartDebugSession(async session => {
    if(!debugSessions.some((sess) => session.id == sess.id)){
      debugSessions.push(session);
    } 
    count+=1;
    app=gdb4hpc.apps[count]
    if(app){
      const config: vscode.DebugConfiguration = {
        ...debugSessions[0].configuration,
      }
      config.request = 'launch'
      config.num = count
      vscode.debug.startDebugging(undefined, config)
    }
  })

  vscode.debug.onDidTerminateDebugSession(async (session:vscode.DebugSession )=>{
    let i = debugSessions.findIndex(dbgsess=>{dbgsess.id == session.id})
    if (i){
      debugSessions.splice(i,1);
    }
    if(debugSessions.length==0){
      gdb4hpc.sendCommand("-gdb-exit");
      count = 0;
    }
  })

  vscode.debug.onDidChangeActiveDebugSession(async(session:vscode.DebugSession|undefined)=>{
    if (session){
      if(debugSessions.length==0) debugSessions.push(session)
      let i = debugSessions.findIndex(dbgsess=>dbgsess.name === session.name)
      let line = gdb4hpc.getCurrentLine(i);
      let file = gdb4hpc.getCurrentFile(i);
      gdb4hpc.openToFile(line,file);
    }
  })
  
  /* 
  //Extra debug data to development console
  vscode.debug.registerDebugAdapterTrackerFactory('*', {
    createDebugAdapterTracker(session: vscode.DebugSession) {
      return {
        onWillReceiveMessage: m => console.log(`> ${JSON.stringify(m, undefined, 2)}`),
        onDidSendMessage: m => console.log(`< ${JSON.stringify(m, undefined, 2)}`)
      };
    }
  });
  */
}

export function deactivate() {
  count = 0;
	// nothing to do
}


//gdb4hpc functions
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

export function setBreakpoints(file, breakpoints){
  return gdb4hpc.setBreakpoints(file,breakpoints)
}

export function launchApp(num){
  return gdb4hpc.launchApp(num)
}

export function next_cmd(){
  return gdb4hpc.next()
}

export function continue_cmd(){
  return gdb4hpc.continue()
}

export function pause_cmd(){
  return gdb4hpc.pause()
}

export function terminate_cmd(){
  return gdb4hpc.terminate()
}

export function stepIn_cmd(){
  return gdb4hpc.stepIn()
}

export function stepOut_cmd(){
  return gdb4hpc.stepOut()
}

export function getThreads(){
  return gdb4hpc.getThreads()
}

export function stack(startFrame, endFrame,threadId,name){
  return gdb4hpc.stack(startFrame, endFrame,threadId,name)
}

export function getVariables(){
  return gdb4hpc.getVariables()
}

export function getVariable(expression){
  return gdb4hpc.getVariable(expression)
}

export function spawn(args){
  return gdb4hpc.spawn(args)
}

export function sendCommand(expression){
  return gdb4hpc.sendCommand(expression)
}

export function writeToPty(expression){
  return gdb4hpc.writeToPty(expression)
}

export function isStarted(){
  return gdb4hpc.isStarted()
}

export function on_cmd(event, callback){
  return gdb4hpc.on(event, callback)
}




class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  private session: any;

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
    this.session = new DebugSession(app.name,count);
    this.session.supportsStartDebugging =true
		return new vscode.DebugAdapterInlineImplementation(this.session);
	}

  getSession(){
    return this.session;
  }

}

