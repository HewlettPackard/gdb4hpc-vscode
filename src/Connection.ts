// Copyright 2024-2025 Hewlett Packard Enterprise Development LP.

import * as ssh from 'ssh2'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as vscode from 'vscode'
import { setTimeout } from 'timers';
import { spawn } from 'child_process'

export class Connection{
  private shellStream:any = null;
  private sftp_conn:any = null;
  private tmpDir:string ="";
  private remote:boolean = false;
  private term: vscode.Terminal|null = null;

  public startConnection(configuration, dataCallback, closeCallback):Promise<void>{
    //always remote on windows otherwise check the connection type.
    this.remote = process.platform==='win32'?true:(configuration.host?true:false)
    return new Promise((resolve,reject)=>{
      if (this.remote){
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
          this.shellStream = spawn('script',['-q', '--command=bash -l', '/dev/null'], configuration);
          const writeEmitter = new vscode.EventEmitter<string>();
          const closeEmitter = new vscode.EventEmitter<void>();
          const shellProc = this.shellStream;
          const pty: vscode.Pseudoterminal = {
            onDidWrite: writeEmitter.event,
            onDidClose: closeEmitter.event,

            open(): void {
              shellProc.stdout!.on('data',(data: Buffer) => {
                let ret = dataCallback(data);
                writeEmitter.fire(data.toString())
                if(ret){
                  resolve()
                }
              });

              shellProc.stderr!.on('data',(data:Buffer) => {
                console.error("Error from stream:", data.toString())
              });

              shellProc.on('exit', () => {
                closeCallback();
                closeEmitter.fire();
              });
            },

            close(): void {
              shellProc.kill();
              closeCallback();
            },

            handleInput(data: string): void {
              if(data.startsWith("gdb4hpc")){
                shellProc.stdin!.write(`gdb4hpc --interpreter=mi\n`)
              }else{
                shellProc.stdin!.write(data);
              }
            },
          };
          this.term = vscode.window.createTerminal({
            name: 'GDB4HPC PTY',
            pty: pty
          });
          this.term.hide();
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
    if(!this.shellStream) return;
    this.remote?this.shellStream.write(`${data}`):this.shellStream.stdin!.write(data);
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
