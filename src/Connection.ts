// Copyright 2024-2025 Hewlett Packard Enterprise Development LP.

import * as ssh from 'ssh2'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as vscode from 'vscode'
import { setTimeout } from 'timers';

export class Connection{
  private shellStream:any = null;
  private sftp_conn:any = null;
  private tmpDir:string ="";

  public startConnection(configuration, dataCallback, closeCallback):Promise<void>{
    //always remote on windows otherwise check the connection type.
    let remote = process.platform==='win32'?true:(configuration.host?true:false)
    return new Promise((resolve,reject)=>{
      if (remote){
        let conn = new ssh.Client();
        conn.on('ready',()=>{
          conn.shell((err,stream)=>{
            if(err){
              reject(err)
              return;
            }
            this.shellStream = stream;
            stream.on('data',(data)=>{
              let ret = dataCallback(data);
              if(ret){
                resolve()
              }
            })
            stream.on('close',()=>{
              closeCallback();
              conn.end();
            })
          })
          conn.sftp(async (err,sftp)=>{
            this.sftp_conn=sftp;
          })
        }).connect(configuration)
      }else{
        try{
          const {spawn} = require('node-pty')
          this.shellStream = spawn('bash', [], configuration);
          this.shellStream.onData((data)=>{
            let ret = dataCallback(data);
            if(ret) resolve()
          })
          this.shellStream.onExit((e) => { 
            closeCallback();
          });
        }catch(err){
          reject(err)
        }
      }
    })
  }

  public async uploadFileSFTP(localPath,remotePath):Promise<boolean>{
    if (remotePath.length<=0) {
      return new Promise((resolve)=>{
        resolve(false);
      })
    }
    return await new Promise(async (resolve,reject)=>{
      let timedOut = false;
      const timeoutId = setTimeout(()=>{
        timedOut=true;
        reject(new Error('fastGet timed out'))
      },120000)
      this.sftp_conn.fastPut(localPath, remotePath,(err)=>{
        if (timedOut) return;
        clearTimeout(timeoutId)
        err? reject(err):resolve(true);
      })
    })
  }

  public async getFileSFTP(file:string):Promise<string>{
    if(file.length==0){
      vscode.window.showErrorMessage("No file")
      return ""
    }
    return await new Promise(async (resolve,reject)=>{
      if (this.tmpDir.length==0) this.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gdb4hpc-vscode-src-'));
      const localPath = path.resolve(this.tmpDir, String(file).replace(/\//g,''));
      this.ensureDirExists(localPath)
      let timedOut = false;
      const timeoutId = setTimeout(()=>{
        timedOut=true;
        reject(new Error('fastGet timed out'))
      },120000)
      this.sftp_conn.fastGet(file, localPath,(err)=>{
        if (timedOut) return;
        clearTimeout(timeoutId)
        err? reject(err):resolve(localPath);
      })
    })
  }
  
  public writeToShell(data){
    if(this.shellStream) this.shellStream.write(`${data}`);
  }

  public removeFiles(){
    if(this.tmpDir.length>0) fs.rmSync(this.tmpDir, { force:true, recursive: true });
  }
  
  private ensureDirExists(file_path){
    const dir = path.dirname(file_path);
    if(!fs.existsSync(dir)){
      fs.mkdirSync(dir,{recursive:true});
    }
  }
}
