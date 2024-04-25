// Copyright 2024 Hewlett Packard Enterprise Development LP.

import * as vscode from 'vscode';

export class FocusProvider implements vscode.WebviewViewProvider {
  
  public static readonly viewType = 'focusView';

	public _view: vscode.WebviewView;

	constructor(
		private readonly _extensionUri: vscode.Uri,
		private readonly session: any
	) {	}

	public resolveWebviewView(webviewView: vscode.WebviewView,context: vscode.WebviewViewResolveContext,_token: vscode.CancellationToken) {
		this._view = webviewView || null;

		this._view.webview.options = {
			// Allow scripts in the webview
			enableScripts: true,

			localResourceRoots: [
				this._extensionUri
			]
		};

		this._view.webview.onDidReceiveMessage( message => {
      switch (message.command) {
        case 'toggledFocus':
					this.session.gdb4hpc.changeFocus(message.id).then(this.refresh());
					break;
      }
    })		

		//reference to display of panel
		this._view.webview.html = this._getHtmlForWebview(this._view.webview);	
	}

	addPe(): void {
    let input_name_box: vscode.InputBoxOptions = {
      prompt: "Name for new PE ",
      placeHolder: "abc"
    }

    let input_procset_box: vscode.InputBoxOptions = {
      prompt: "Name for new PE ",
      placeHolder: "$App0{2},$App1{0..3}"
    }

    let name = "";
    let procset = "";
  
    //show input boxes for name and procset and then send defset message
    vscode.window.showInputBox(input_name_box).then(value => {
      if (!value) return;
      name = value;
      vscode.window.showInputBox(input_procset_box).then(value => {
        if (!value) return;
        procset = value;
        this.session.gdb4hpc.addProcset(name, procset).then(this.refresh())
      });
    });    
  }

	refresh(): void {
    this.session.gdb4hpc.getProcsetList().then((a)=> {
			console.warn(a)
			this._view?.webview.postMessage({type:'focusUpdated', value: a})
		});
  }

	private _getHtmlForWebview(webview: vscode.Webview) {
		//references to style sheets for vscode styling
		const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
		const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));

		//reference to script used by assertion display
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'src', 'focusScript.js'));

		//security policy reference
		function getNonce() {
			let text = '';
			const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
			for (let i = 0; i < 32; i++) {
				text += possible.charAt(Math.floor(Math.random() * possible.length));
			}
			return text;
		}

		const nonce = getNonce();

		return `<!DOCTYPE html>
    <html lang="en">
    <head>
				<meta charset="UTF-8">

				<!--
					Use a content security policy to only allow loading styles from our extension directory,
					and only allow scripts that have a specific nonce.
					(See the 'webview-sample' extension sample for img-src content security policy examples)
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${styleResetUri}" rel="stylesheet">
				<link href="${styleVSCodeUri}" rel="stylesheet">
    </head>
    <body>
				<ul id='focus-list'>
				</ul>
				<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
    </html>`;
	}
}