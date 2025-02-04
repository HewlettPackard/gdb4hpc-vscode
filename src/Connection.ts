// Copyright 2024-2025 Hewlett Packard Enterprise Development LP.

import * as ssh from 'ssh2'
import * as pty from 'node-pty'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as vscode from 'vscode'
import { setTimeout } from 'timers';

let shellStream:any = null;
let remote: boolean;
let sftp_conn:any = null;
let ssh_config:any;
const file_map = {};
let tmpDir:string ="";

export function startConnection(conn_type, configuration, dataCallback, closeCallback){
  remote = conn_type
  ssh_config=configuration
  switch (remote){
    case true:
      let conn = new ssh.Client();
      return new Promise((resolve,reject)=>{
        conn.on('ready',()=>{
          conn.shell((err,stream)=>{
            if(err){
              reject(err)
              return;
            }
            shellStream = stream;
            stream.on('data',(data)=>{
              let ret = dataCallback(data);
              if(ret){
                resolve(true)
              }
            })
            stream.on('close',()=>{
              closeCallback();
              removeFiles();
              conn.end();
            })
          })
          conn.sftp(async (err,sftp)=>{
            sftp_conn=sftp;
          })
        }).connect(ssh_config)
      })

    case false:
      shellStream = pty.spawn('bash', [], ssh_config);
      return new Promise((resolve)=>{
        shellStream.onData((data)=>{
          let ret = dataCallback(data);
          if(ret){
            resolve(true)
          }
        })
    
        shellStream.onExit((e) => { 
          closeCallback();
        });
      })
  }
}

function removeFiles(){
  if(tmpDir.length>0) fs.rmSync(tmpDir, { recursive: true });
}

function ensureDirExists(file_path){
  const dir = path.dirname(file_path);
  if(!fs.existsSync(dir)){
    fs.mkdirSync(dir,{recursive:true});
  }
}

async function copyFileSFTP(file):Promise<string>{
  if (file_map[file]) {
    return new Promise((resolve)=>{
      resolve(file_map[file]!);
    })
  }
  if (tmpDir.length==0) tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdb4hpc-vscode-src-'));
  const localPath = path.resolve(tmpDir, file.replace("/",""));
  ensureDirExists(localPath)
  file_map[file]=localPath
  return await new Promise(async (resolve,reject)=>{
    let timedOut = false;
    const timeoutId = setTimeout(()=>{
      timedOut=true;
      reject(new Error('fastGet timed out'))
    },120000)
    sftp_conn.fastGet(file, localPath,(err)=>{
      if (timedOut) return;
      clearTimeout(timeoutId)
      err? reject(err):resolve(localPath);
    })
  })
}


//point to the current line in the current file
export function displayFile(line:number, file:string){
  function openFile(file:string,line:number){
    var openPath = vscode.Uri.file(file); 
    vscode.workspace.openTextDocument(openPath).then(doc => {
      vscode.window.showTextDocument(doc).then(editor => {
        let range = editor.document.lineAt(line-1).range;
        editor.selection =  new vscode.Selection(range.start, range.end);
        editor.revealRange(range);
      });
    });
  }
  //if (!file) return;
  if(file.length>0&&line>0){
    if (remote){
      let local=file_map[file]?file_map[file]:file
      let found=vscode.workspace.textDocuments.find((doc)=>doc.uri.fsPath.includes(local))
      async function getFile(){
        await getFileFromRemote(file).then((path)=>{
          if(file.length==0){
            vscode.window.showErrorMessage("No file")
            return;
          }
          file=path
        })
      }
      
      if(found){
        vscode.window.showTextDocument(found).then(editor => {
          let range = editor.document.lineAt(line-1).range;
          editor.selection =  new vscode.Selection(range.start, range.end);
          editor.revealRange(range);
        });
      }else{
        getFile().then(()=>{
          openFile(file,line)
        })
      }
    }else{
      openFile(file,line)
    }
  }
}

async function getFileFromRemote(file):Promise<string>{
  return new Promise(async (resolve,reject)=>{
    await copyFileSFTP(file).then(path=>{
      resolve(path)
    })
  })
}

export function writeToShell(data){
    shellStream.write(`${data}`);
}

//if ssh connection, get remote file path otherwise return original
export function getRemoteFile(file:string):string{
  if(remote){
    let a = (Object.keys(file_map) as string[]).find(key => file_map[key]===file)
    if(a) return a;
  }
  return file
}