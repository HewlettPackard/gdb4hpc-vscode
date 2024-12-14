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
      this.apps = config.apps;
      //config.name = config.apps[0].name
      //config.num = count+1
    }
    return config;
  }
}

export let debugSessions:vscode.DebugSession[] = [];
export let app:any;
export let count = 0;

export function activate(context: vscode.ExtensionContext) {
  const provider = new GDB4HPCConfigurationProvider();
  console.error("provider")
  context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider('gdb4hpc', provider));
  console.error("provider pushed:",provider.apps)
  app={name:"App0"};
  let factory = new InlineDebugAdapterFactory();
	context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory('gdb4hpc', factory));
  context.subscriptions.push(vscode.commands.registerCommand('getContext', () => context));

  let session = factory.getSession();

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
    app = gdb4hpc.apps[count]
    if(app){
      const config: vscode.DebugConfiguration = {
        ...debugSessions[0].configuration,
      }
      config.request = 'launch'
      config.name = app.name
      config.num = count
      vscode.debug.startDebugging(undefined, config)
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
	// nothing to do
}

class InlineDebugAdapterFactory implements vscode.DebugAdapterDescriptorFactory {
  private session: any;

	createDebugAdapterDescriptor(_session: vscode.DebugSession): ProviderResult<vscode.DebugAdapterDescriptor> {
    this.session = new DebugSession(app.name,count);
    //console.error("app:",app,"   app num:",count)
    //console.error("session name:",this.session.name,"   session num:",this.session.num)
    this.session.supportsStartDebugging =true
		return new vscode.DebugAdapterInlineImplementation(this.session);
	}

  getSession(){
    return this.session;
  }

}

