// Copyright 2024-2025 Hewlett Packard Enterprise Development LP.

import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { clearInterval } from 'timers';
import { readFileSync } from 'fs';
import { DebugProtocol } from '@vscode/debugprotocol';
import { Record, MIParser } from './MIParser';
import { compare_list } from './CompareProvider';
import { Connection } from './Connection'
import { ILaunchRequestArguments } from './DebugSession';
import { DataStore, data } from './DataStore';

export interface Procset {
	name: string;
	procset: string;
  isSelected: boolean;
}

export class GDB4HPC extends EventEmitter {
  public cwd: string;
  public apps: any;
  private environmentVariables: string[];
  private setupCommands: string[];
  private output_panel: vscode.OutputChannel;
  private mi_log: vscode.OutputChannel;
  private error_log: vscode.OutputChannel;
  private cmdPending: any[] = [];
  private data ='';
  private parser: MIParser = new MIParser();
  private token = 1;
  private appendedVars: string[];
  private launchCount:number =0;
  private connConfig = {};
  private runningCommands: { [key: string]: Promise<any>|null|"avail" } = {
    '-thread-info':"avail",
    '-stack-list-frames':"avail",
    '-procset-list':"avail",
    '-var-update --all-values *':"avail",
    '-stack-list-variables':"avail"
  }
  public conn:Connection = new Connection();
  public dataStore:DataStore = new DataStore();

  //spawn gdb4hpc
  public spawn(args: ILaunchRequestArguments): Promise<boolean>  {
    this.cwd = args.cwd || '';
    this.environmentVariables = args.env || [];
    this.dataStore.setStatus("remote",args.connConfig.host?true:false);
    this.connConfig = args.connConfig.host?{
      host: args.connConfig.host,
      port: args.connConfig.port,
      username: args.connConfig.username,
      privateKey: readFileSync(args.connConfig.privateKey)
    }:{
      stdio:['pipe','pipe','pipe'],
      cwd: this.cwd,
      env: Object.assign(this.environmentVariables, process.env, this.appendedVars)
    }

    this.appendedVars=[];
    let regex = /\$(\w+)\:([\s\S]*)/;
    let match: any[]|null;
    for (const key in args.env) {
      if ((match = regex.exec(args.env[key]))) {
        this.appendedVars[key]=match[2]+":"+process.env[match[1]];
      }
    }
    this.apps = args.apps;
    this.apps.forEach((app)=>{
      let procsets=app.procset.split(/\{|\}/)
      let group = "0.."+(parseInt(procsets[1])-1)
      this.dataStore.setStatus("appData", {program: app.program, args: app.args}, procsets[0], group)
    })
    this.setupCommands = args.setupCommands
    this.output_panel = vscode.window.createOutputChannel("Program Output")
    this.mi_log = vscode.window.createOutputChannel("MI Log");
    this.error_log = vscode.window.createOutputChannel("Error Log");
    vscode.workspace.onDidSaveTextDocument((document)=>{
      let localPath = document.uri.fsPath;
      let remotePath = this.dataStore.convertSourceFilePath(true,localPath)
      if(remotePath.length>0) this.conn.uploadFileSFTP(localPath,remotePath)
    })
    return new Promise(resolve => {
      this.createStream().then(()=>{
        resolve(true)
      })
    })
  }

  //launch applications
  public launchApps():  Promise<boolean> {
    return new Promise(resolve => {
      let merged:any=[];
      this.apps.forEach((app,index)=>{
        this.sendCommand(`launch $`+ app.procset + ` ` + app.program + ` ` + app.args).then(()=>{
          merged.push(app.procset)
          let split =app.procset.split(/\{|\}/)
          this.dataStore.setStatus("focused",{name:"all",procset:merged.join(",")});
          this.dataStore.setStatus("appRunning",true)
          let group:string = "0.."+(parseInt(split[1])-1).toString()
          this.dataStore.setStatus("groupFilter",null,split[0],group)
          if (index==0) this.dataStore.setStatus("sourceDisplay",{app:split[0],rank:"0"})  
          this.launchCount ++;
          Promise.all(this.cmdPending).then(() => {
            resolve(true); 
          });
        })
      })
      Promise.all(this.cmdPending).then(() => {
        resolve(true); 
      });
    });
  }

  //create shell stream to connect gdb4hpc to vscode
  private createStream(): Promise<boolean> {
    //callback for handling data
    let onData = (data) =>{
      //remove color codes
      data = data.toString()
      data = data.replaceAll("\x1b[0m","");
      data = data.replaceAll("\x1b[30;1m","");
      data = data.replace("dbg all> ","");

      //check to see gdb4hpc is running, if so launch program
      if (!this.dataStore.getStatus("started")){
        if(data.includes("(gdb)")){
          this.dataStore.setStatus("started",true);
          return true;
        }
      }
      this.handleOutput(data);
    }

    //callback to close gdb4hpc connection
    let onClose = () =>{
      this.output_panel.dispose();
      this.mi_log.dispose();
    }

    //setup local/remote connection
    return new Promise(resolve => {
      this.conn.startConnection(this.connConfig,onData,onClose).then(()=>{
        resolve(true)
      },(err)=>{
        console.error(err)
        resolve(false)
      })
      vscode.commands.executeCommand("workbench.panel.repl.view.focus")
      //if setupCommands are provided, use them to launch gdb4hpc
      if (this.setupCommands.length>0){
        this.setupCommands.forEach(item => {
          this.conn.writeToShell(`${item}\n`)
        });
        this.conn.writeToShell(`gdb4hpc --interpreter=mi\n`);
      }else{
        vscode.window.showInformationMessage("Please add setupCommands or launch gdb4hpc in the Debug Console")
      }
      
    });
  }

  //intercept commands before sending to gdb4hpc in case of duplicates
  public sendCommand(command:string): Promise<any> { 
    //if not in list send command and return promise as normal
    if(!(command in this.runningCommands)){
      return this.send(command);
    }

    //If available send the command to gdb4hpc
    if(this.runningCommands[command]=="avail"){
      this.runningCommands[command]= this.send(command).finally(()=>{
        this.runningCommands[command]= null;
      })
       //return for the call that started the command run
      return this.runningCommands[command];
    }else if(this.runningCommands[command]){
      this.runningCommands[command].then(()=>{
        return new Promise<null>((resolve)=>{resolve(null)});
      })
    }
    return new Promise<null>((resolve)=>{resolve(null)});
  }

  //send command to shell and get the parsed output back
  private send(command: string): Promise<any> {
    return new Promise(resolve => {
      if (!this.dataStore.getStatus("started")){
        if (command.startsWith("gdb4hpc")){
          //start gdb4hpc with the interpreter set to mi
          this.conn.writeToShell(`${command} --interpreter=mi\n`);
        }else{
          this.conn.writeToShell(`${command}\n`);
        }
      }
      else if (!command.startsWith("-")) {
        this.conn.writeToShell(`${command}\n`);
        resolve(true);
      }
      else {
        this.conn.writeToShell(`${this.token + command}\n`);
        //once token is found the parsed record is sent back to the function that called the command
        this.cmdPending.push({token: this.token, res: ((record: Record) => {
          resolve(record);
        })})
        this.token++;
      }
    });
  }

  private handleOutput(data: any): void {
    let lines: string[] = []
    const getLines = (i: number)=>{
      if(i < 0) return;
      lines = this.data.slice(0, i).split('\n');
      this.data = this.data.slice(i + 1);
    }
    this.data+=data;
    if (!this.data) return;
    
    getLines(this.data.lastIndexOf('\n'));

    lines.forEach(line => {
      line = line.trim();

      //if gdb4hpc is not started, show all output in Debug Console
      if (!this.dataStore.getStatus("started")){
        this.emit('output', line, 'console');
        return;
      }
      let record = this.parser.parseRecord(line);
      if(record){
        switch (record.type) {
          case '*':
            this.handleAsyncRecord(record);
            break;

          case '~':
            this.emit('output', record.recStr, 'console');
            break;

          case 'mi':
              this.mi_log.appendLine(record.recStr);
              break;
          
          case '@':
            this.output_panel.appendLine(record.recStr);
            this.output_panel.show(); //always display output panel if output was added
            break;
          
          case '^':
            if (!isNaN(record.token)) {
              const promise = this.cmdPending.find((element) => element.token == record!.token);
              promise?.res(record);
              const index = this.cmdPending.indexOf(promise);
              (index > -1)?this.cmdPending.splice(index, 1):null;
              
            }else{
              if(record.reason=="error"){
                vscode.window.showErrorMessage(record.info?.get('msg'));
                this.error_log.appendLine(record.info?.get('msg'));
                this.error_log.show();
              }
            }
            break;
          default:
            break;
        } 
      }else{
        if(line.toLowerCase().includes("error")){
          this.error_log.appendLine(line);
        }
      }
    });
  }

  private handleAsyncRecord(record: Record) {
    switch (record.reason) {
      case 'stopped':
          this.dataStore.setStatus("appRunning",false);
          this.makeCommandsAvailable()
          let reason = record.info?.get('reason');
          switch (reason) {
            case 'breakpoint-hit':
            case 'end-stepping-range':
              this.emitEvent(reason);
              break;

            case 'exited-normally':
              this.sendCommand('-gdb-exit');
              this.emitEvent(reason);
              break;

            default:
              console.error('Unknown stop reason');
              this.emitEvent(reason);
          }
        break;

      case 'running':
        this.dataStore.setStatus("appRunning",true);
        break;
    }
  }

  private emitEvent(event: string){
    if(event=='exited-normally'){
      this.emit('exited-normally')
    }else if(event=='breakpoint-hit'|| event=='end-stepping-range'){
      this.getThreads().then((threads)=>{
        let thread = this.dataStore.filterSourceDisplay(threads)
        let id = thread? thread.value[0].id:0
        this.emit(event,id);
      })
    }
  }

  private makeCommandsAvailable(){
    for(let key in this.runningCommands){
      this.runningCommands[key]="avail"
    }
  }

  public continue(): Promise<any> {
    return this.sendCommand('-exec-continue');
  }

  public stepIn(): Promise<any> {
    return this.sendCommand(`-exec-step`);
  }

  public stepOut(): Promise<any> {
    return this.sendCommand(`-exec-finish`);
  }

  public next(): Promise<any> {
    return this.sendCommand(`-exec-next`);
  }

  public pause(): Promise<any> {
    return this.sendCommand(`-exec-interrupt`);
  }

  public terminate(): Promise<any> {
    return new Promise((resolve) => {
      this.sendCommand('-gdb-exit').then(() => {
        this.conn.closeConnection();
        resolve(true);
      }).catch(() => {
        this.conn.closeConnection();
      });
    });
  }

  private getThreads(): Promise<data[]> { 
    return new Promise(resolve => {
      this.sendCommand('-thread-info').then((record: Record|null) => {
        if(record && record.info?.has('msgs')) this.dataStore.setThreads(record.info?.get('msgs'))
        let threads = this.dataStore.getThreads()
        resolve(threads);      
      });
    });
  }

  public getThreadResults(): Promise<DebugProtocol.Thread[]> { 
    return new Promise(resolve => {
      let results:DebugProtocol.Thread[]=[]
      this.getThreads().then((threads:data[]) => {
        let res = this.dataStore.filterGroupDisplay(threads)
        results=res.flatMap((item)=>item.value)
        resolve(results);      
      });
    });
  }

  public evaluateVariable(name: string): Promise<{value:string,variableReference:number}> {
    return new Promise(resolve => {
      if (!this.dataStore.varExists(name)){
        this.createVariable(name).then(() => {
          let result = this.dataStore.getVariableValue(name)
          resolve(result);
        });
      }
      this.updateVariables().then(() => {
        let result = this.dataStore.getVariableValue(name)
        resolve(result);
      });
    })
  }

  //mi variable sends value in format of $a{i}: val\n$b{j}: val\n...etc. 
  //parse out the procset, group, and value for each procset in the value
  public parseVariableRecord(str: string): any[]{
    if (!str) return [{}];
    let split_variables = /\\n(?=\w+\{?[\S]*\}?\:)/;
    let variables_str = str.split(split_variables);
    let result: any[] = [];
    variables_str.forEach(variable=>{
      let regex = /(\w+)\{([\S]*)\}\:([\s\S]*)/;
      let match: any[]|null;
      if ((match = regex.exec(variable))) {
        result.push({'procset':match[1],'group':match[2], 'value':match[3]})
      }
    })
    return(result)
  }

  //send var-create command to gdb4hpc and retreive output
  private createVariable(name: string): Promise<boolean> {
    return new Promise(resolve => {
      this.sendCommand(`-var-create - * "${name}"`).then((recordVariable) => {
        let variables_match = this.parseVariableRecord(recordVariable.info!.get('value'));
        const numchild = parseInt(recordVariable.info!.get('numchild')) || parseInt(recordVariable.info!.get('has_more')) || 0;
        //create an array of values from mi message          
        let vars:any[] = [];
        variables_match.forEach(variable=>{
          let v = {proc_set:variable.proc_set,group:variable.group,name:name,evaluateName:recordVariable.info!.get('name'),
            type:recordVariable.info!.get('type'),variableReference:numchild,value:variable.value
          }
          vars.push(v)
        });
        this.dataStore.updateVars(vars)
        resolve(true);
      });
    });
  }
  
  // send var-update command to gdb4hpc and get answer
  private updateVariables(): Promise<boolean> {
    return new Promise(resolve => {
      this.sendCommand(`-var-update --all-values *`).then((record:Record|null)=> {
        let vars:any[] = [];
        if(record){
          record.info?.get('changelist').forEach(variableRecord => {
            //get the new values for possibly different procsets and groups
            let variables_match = this.parseVariableRecord(variableRecord.value);
            variables_match.forEach(variable_match =>{
              //find saved variable corresponding to variable being updated from mi message
              let v = {proc_set:variable_match.proc_set,group:variable_match.group,
                evaluateName:variableRecord.name, value:variable_match.value}
              vars.push(v)
            })
          });
          this.dataStore.updateVars(vars)
        }
        resolve(true);
      });
    });
  }

  //get list of variables from gdb4hpc
  public getVariables(): Promise<data[]> {
    return new Promise(resolve => {
      this.sendCommand(`-stack-list-variables`).then((record: Record|null) => {
        if(record) this.dataStore.updateVars(record.info?.get('variables'))
        resolve(this.dataStore.getLocalVariables());
      });
    });
  }

  public rangeToString(group:[number,number][]):string{
    return this.dataStore.rangeToString(group)
  }

  public stack(startFrame: number, endFrame: number, id:number): Promise<DebugProtocol.StackFrame[]> {
    return new Promise((resolve) => {
      this.sendCommand('-stack-list-frames').then((record: Record | null) => {
        let pendingPromises:Promise<boolean>[]=[]
          if (record) {
            pendingPromises = record.info?.get('msgs').map((message: any) =>
              this.dataStore.setStack(startFrame, endFrame, message)
            );
            Promise.all(pendingPromises).then(() => {
              const final = this.dataStore.getThreadStack(id);
              resolve(final);
            });
          }else{
            const final = this.dataStore.getThreadStack(id);
            resolve(final);
          }
      });
    });
	}

  public setSourceBreakpoints(file: string, breakpoints: DebugProtocol.SourceBreakpoint[]): Promise<DebugProtocol.Breakpoint[]> {
    let pending: Promise<boolean>[] = [];
    
    //SetBreakpointRequest clears all breakpoints
    const clearBkpts = (file: string): Promise<boolean>=>{
      return new Promise(resolve => {
        const fileBkpts = this.dataStore.removeSourceBreakpoints(file)
        fileBkpts.forEach((bkpt) => {
          this.sendCommand(`-break-delete ${bkpt.id}`);
        });
        resolve(true); 
      });
    }

    //Send Command to insert new breakpoint
    const insertBkpt = (file: string, line: number): Promise<any> =>{
      let remote_file = this.dataStore.convertSourceFilePath(true,file)
      // XXX: setting breakpoint pending every time is a hack we have to do until CPE-6345 is implemented
      return this.sendCommand("-gdb-set breakpoint pending on")
        .then(() => this.sendCommand(`-break-insert ${remote_file}:${line}`))
        .then((breakpoint: Record) => {
          const bkpts = breakpoint.info!.get('bkpts');
          if (!bkpts) return;
          for (const bkpt of bkpts) {
            const sourceRef = this.dataStore.getStatus("remote") ? 1 : 0;
            this.dataStore.addSourceBreakpoints({
              verified: true,
              line: bkpt.line,
              source: {
                path: file,
                sourceReference: sourceRef,
              },
              id: parseInt(bkpt.number)
            });
          }
      });
    }

    return new Promise(resolve => {
      //gdb4hpc needs to be connected and ready before breakpoints can be set
      if (this.dataStore.getStatus("appRunning")==true){
        const intv = setInterval(() => {
          if (!this.dataStore.getStatus("appRunning")) {
            clearInterval(intv);
            this.setSourceBreakpoints(file, breakpoints).then(bps =>resolve(bps));
          }
        }, 100);
      }else{
        clearBkpts(file).then(() => {
          breakpoints.forEach(srcBkpt => pending.push(insertBkpt(file, srcBkpt.line)));
          Promise.all(pending).then(() => {
            let bkpts = this.dataStore.getSourceBreakpoints()
            if(bkpts){
              const fileBkpts = bkpts.filter(bkpt => {
                return bkpt.source?.path == file;
              });
              resolve(fileBkpts);
            }
            resolve([])
          });
        });
      }
    });
  }

  public async setFunctionBreakpoints(breakpoints: DebugProtocol.FunctionBreakpoint[]): Promise<DebugProtocol.Breakpoint[]> {
    // the passed in list is meant to replace the current list, so delete old breakpoints.
    //
    // XXX: disabling a breakpoint in the GUI results in an identical DAP message as deleting it,
    // so we can't distinguish between the two actions. this means that we delete breakpoints even
    // when they're just being disabled. this can result in subtle errors like the tracking
    // of number of times the breakpoint has been hit being reset.
    const functionBreakpoints = this.dataStore.removeFunctionBreakpoints();

    // delete them all
    const pendingDeletions = functionBreakpoints.map(bkpt => this.sendCommand(`-break-delete ${bkpt.id}`));

    // and set and cache the new breakpoints
    const pendingInsertions = breakpoints.map(bkpt => this.sendCommand(`-break-insert ${bkpt.name}`));

    // FIXME: we should be error checking and handling the case that 1 of n commands fail
    //
    // FIXME: while we await here, something else could try to use functionBreakpoints.
    // that probably would result in explosion.
    const rawResults = await Promise.all([...pendingDeletions, ...pendingInsertions]);

    for (const record of rawResults) {
      // note that we are also iterating the results of the deletions here. those
      // simply return a ^done, so we are silently skipping them by checking that bkpts isn't null
      const bkpts = record.info?.get('bkpts');
      if (bkpts) {
        for (const bkpt of bkpts) {
          this.dataStore.addFunctionBreakpoints({
            id: parseInt(bkpt.number) || undefined,
            verified: true,
            line: parseInt(bkpt.line) || undefined,
            source: {
              name: bkpt.file || undefined,
              path: bkpt.fullname || undefined,
            },
            // FIXME: we need to keep track of function names, but
            // DAP breakpoint objects don't have a "name" field.
            // we use instructionReference as a hack around it for now.
            instructionReference: bkpt.func,
          });
        }
      } else {
        // XXX: gdb4hpc has a bug where it doesn't return ^done when a breakpoint is
        // inserted as pending (and thus we don't get a record with bkpt),
        // so in that case we'll actually never even complete the insertion of the
        // breakpoints and we'll never reach this branch anyway. see CPE-9350
      }
    }

    return this.dataStore.getFunctionBreakpoints();
  }

  public addProcset(name: string, procset: string): Promise<boolean> {
    return new Promise(resolve => {
      this.sendCommand(`-procset-define $${name} $${procset}`);

      if (name) this.dataStore.setStatus("focused",{name:name,procset:procset})
      resolve(true)
    })
	}

  public getProcsetList(): Promise<Procset[]> {
    return new Promise(resolve => {
      this.sendCommand(`-procset-list`).then((record: Record|null) => {
        let pe_list:{name:string,procset:string,isSelected:boolean}[]= [];
        if(record) {
          record.info?.get('pe_sets').forEach(set =>{
            let selected = (set.name == this.dataStore.getStatus("focused").name)?true:false;
            pe_list.push({name:set['name'], procset:set['proc_set'],isSelected:selected})
          })
          this.dataStore.setStatus("pe",pe_list)
        }
        resolve(this.dataStore.getStatus("pe"));
      })  
    });
	}

  public changeFocus(input: string): Promise<boolean> {
    return new Promise(resolve => {
      this.sendCommand(`-procset-focus $${input}`).then((record: Record) => {
        let name = record.info?.get('focus').name;
        let procsets = record.info?.get('focus').procset
        if(name) this.dataStore.setStatus("focused",{name:name,procset:procsets})
        resolve(true);
      })
    });
	}

  public buildDecomposition(new_decomp: any): Promise<any> {
    return new Promise(resolve => {
      if (new_decomp.length == 0){
        resolve(false);
      }
      
      let cmds = new_decomp.join("\n");
      this.sendCommand(cmds);
      this.sendCommand(`-decomposition-list`).then((record: Record)=>{
        let decomps = record.info?.get("decompositions");
        resolve(decomps);
      });      
    });
  }

  public runComparisons(): Promise<any> {
    const runComparison = (comparison: any): Promise<boolean> => {
      return new Promise(resolve => {
        this.sendCommand(`-compare ${comparison.text}`).then((record: Record) => {
          if(record.reason =="error"){
            vscode.window.showErrorMessage(record.info?.get('msg'));
          }else{
            comparison.result = record.info?.get("compare")["result"];
            comparison.result=comparison.result.replace(/\\n/g, "\n");
          }
          resolve(true)
        })
      });
    }

    return new Promise(resolve => {
      let pending: Promise<boolean>[] = [];
      compare_list.forEach( (comparison)=>{
        if (comparison.checked){
          pending.push(runComparison(comparison))
        }else{
          comparison.result ="";
        }
      })
      Promise.all(pending).then(() => {
        resolve(compare_list);
      });
    });
	}

  public buildAssertionScript(new_script: any): Promise<boolean> {
    return new Promise(resolve => {
      let cmds:string[] =[];
      cmds.push(`build $${new_script.name}`);
      cmds.push(`set stop ${new_script.stopOnError}`);
      //verbose breakpoints will cause gdb4hpc to emit breakpoint events as they happen, updating display
      cmds.push(`set verbose-breakpoints on`);

      new_script.asserts.forEach(assert =>{
        cmds.push(`assert ${assert.str}`);
      })
      cmds.push(`end`);
      this.sendCommand(cmds.join("\n")).then(() => {
        resolve(true);
      });
      
    });
  }

  public runAssertionScript(assertion: any): Promise<boolean> {
    return new Promise(resolve => {
      this.sendCommand(`start $${assertion.name}`).then(() => {
        resolve(true);
      })
    });
  }

  public getAssertionResults(script: any): Promise<boolean> {
    return new Promise(resolve => {
      this.sendCommand(`-script-list $${script.name} results`).then((record: Record) => {
        let assert_results = record.info?.get("script_result")["assertions"];
        assert_results.forEach((assert, i)=>{
          let updated = script.asserts[i]
          updated["pass"] = assert.pass;
          updated["warn"] = assert.warn;
          updated["fail"] = assert.fail;
        })
        resolve(true);
      })
    });
  }

  public setGroupFilter(value:string){
    value.replace("$","")
    let values = value.split(",")
    values.forEach((val)=>{
      let procsets=val.split(/\{|\}/)
      this.dataStore.setStatus("groupFilter",procsets[1],procsets[0]);
    })
  }

  public setStatus(name:string,val:any,app?:string,group?:string){
    this.dataStore.setStatus(name, val, app?app:undefined,group?group:undefined)
  }
}
