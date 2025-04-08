// Copyright 2025 Hewlett Packard Enterprise Development LP.

import * as vscode from 'vscode';
import { setGroupFilter, setStatus } from './DebugSession';

export class FilterProvider implements vscode.WebviewViewProvider {
  
  public static readonly viewType = 'filterView';

	public _view: vscode.WebviewView;

	constructor(
		private readonly _extensionUri: vscode.Uri
	) {	}

	public resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext,_token: vscode.CancellationToken) {
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
				case 'filterGroup':
					message.procset?setGroupFilter(message.procset):null;
					message.source_filter?setStatus("rankDisplay",message.source_filter):null;
					message.app_filter?setStatus("appDisplay",message.app_filter):null;
					break;
			}
    })		

		//reference to display of panel
		this._view.webview.html = this._getHtmlForWebview(this._view.webview);	
	}

	private _getHtmlForWebview(webview: vscode.Webview) {
		//references to style sheets for vscode styling
		const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
		const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));

		//reference to script used by assertion display
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'src', 'filterScript.js'));

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
				<ul id='filter-input'>
				</ul>
				<script nonce="${nonce}" src="${scriptUri}"></script>
		</body>
    </html>`;
	}
}