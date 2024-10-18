// Copyright 2024 Hewlett Packard Enterprise Development LP.

import {EventEmitter} from 'events';
import {ILaunchRequestArguments} from './DebugSession';
import {Breakpoint, Source, StackFrame, Thread, Variable} from '@vscode/debugadapter';
import {DebugProtocol} from '@vscode/debugprotocol';
import {Record, MIParser} from './MIParser';
import * as vscode from 'vscode';
import * as pty from 'node-pty';
import {clearInterval} from 'timers';
import { compare_list } from './CompareProvider';

export var pe_list: Procset[] = [];

export interface DbgVar {
  name: string;  //name of variable
  referenceName: string;  //name assigned by MI
  childNum: number;   //number of children
  referenceID: number;  //scope tracking id
  type: string;   //variable type
  values: any[];
}

export interface DbgThread{
  procset: string;
  group: number[];
  id: number;
  name: string;
}

export interface DbgBkpt{
  num: number;
  bkpt: Breakpoint;
  file: string;
  fullfile:string;
  line: string;
}

export interface Procset {
	name: string;
	procset: string;
  isSelected: boolean;
}

export class GDB4HPC extends EventEmitter {
  private cwd: string;
  private apps: any;
  private environmentVariables: string[];
  private modulefiles: string[];
  private modulepath:string;
  private gdb4hpcPty: any;
  private output_panel: vscode.OutputChannel;
  private mi_log: vscode.OutputChannel;
  private error_log: vscode.OutputChannel;
  private appRunning = true;
  private cmdPending: any[] = [];
  private data ='';
  private parser: MIParser = new MIParser();
  private token = 1;
  private breakpoints: DbgBkpt[]=[];
  private threads: DbgThread[]=[];
  private variables: DbgVar[]=[];
  private focused:{procset:string,group:number[]}={procset:"",group:[]}

  public spawn(args: ILaunchRequestArguments): void {
    this.cwd = args.cwd || '';
    this.environmentVariables = args.env || [];
    this.apps = args.apps;
    this.modulefiles = args.modules.modulefiles
    this.modulepath = args.modules.modulepath
    this.output_panel = vscode.window.createOutputChannel("Program Output")
    this.mi_log = vscode.window.createOutputChannel("MI Log");
    this.error_log = vscode.window.createOutputChannel("Error Log");
    this.createPty().then(()=>{
      this.launchApps().then(()=>{this.emitEvent('entryFocus')});
    });
  }

  public launchApps():  Promise<boolean> {
    return new Promise(resolve => {
      //for now this should only be one
      this.apps.forEach(app=>{
        this.sendCommand(`launch $`+ app.procset + ` ` + app.program + ` ` + app.args);
        let split = app.procset.split(/\{|\}/)
        let group = "0.."+(parseInt(split[1])-1).toString();
        this.focused.procset=split[0];
        this.focused.group = this.getGroupArray(group);
      });
      resolve(true); 
    });
  }

  private createPty(): Promise<boolean> {
    return new Promise(resolve => {
      this.gdb4hpcPty = pty.spawn('bash', [], {
        name: 'xterm-color',
        cols: 80,
        rows: 30,
        cwd: this.cwd,
        env: Object.assign(this.environmentVariables, process.env),
      });
      
      this.gdb4hpcPty.onData(data => {
        data = data.replace("dbg all> ","");
        //remove color codes
        data = data.replaceAll("\x1b[0m","");
        data = data.replaceAll("\x1b[30;1m","");
        this.handleOutput(data);
      });

      this.gdb4hpcPty.onExit((e) => { 
        this.output_panel.dispose();
        this.mi_log.dispose();
      });

      //load in modulefiles
      if (this.modulepath.trim().length>0){
        this.gdb4hpcPty.write(`module use ${this.modulepath}\n`)
      }
      this.modulefiles.forEach(module => {
        this.gdb4hpcPty.write(`module load ${module}\n`)
      });
      this.gdb4hpcPty.write(`gdb4hpc --interpreter=mi\n`)

      //gdb4hpc is ready to use
      this.appRunning= true;
      resolve(true)
    });
  }
  
  //send command to gdb4hpc and get the parsed output back
  public sendCommand(command: string): Promise<any> {
    return new Promise(resolve => {
      if (!command.includes("-")) {
        command = `${command}\n`;
        this.gdb4hpcPty.write(command);
        resolve(true);
      }
      else {
        command = `${this.token +command}\n`;
        this.gdb4hpcPty.write(command);
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

          if (line.toLowerCase().includes("module")){
            vscode.window.showErrorMessage(line);
            this.error_log.show();
          }
        }
      }
    });
  }

  private handleAsyncRecord(record: Record) {
    switch (record.reason) {
      case 'stopped':
          this.appRunning = false;
          let reason = record.info?.get('reason');
          switch (reason) {
            case 'breakpoint-hit':
            case 'end-stepping-range':
              const fullName=record.info?.get('frame')["fullname"];
              const line = parseInt(record.info?.get('frame')["line"]);

              //open file and line
              var openPath = vscode.Uri.file(fullName); 
              vscode.workspace.openTextDocument(openPath).then(doc => {
                vscode.window.showTextDocument(doc).then(editor => {
                  let range = editor.document.lineAt(line-1).range;
                  editor.selection =  new vscode.Selection(range.start, range.end);
                  editor.revealRange(range);
                });
              });
              break;

            case 'exited-normally':
              this.sendCommand('-quit');
              break;

            default:
              console.error('Unknown stop reason');
          }
          this.emitEvent(reason);
        break;

      case 'running':
        this.appRunning = true;
        break;
    }
  }
  private emitEvent(event: string){
    if(event=='exited-normally'){
      this.emit('exited-normally')
    }else if(event=='breakpoint-hit'|| event=='end-stepping-range'){
      if (this.threads&&this.threads.length>0){
        this.threads.forEach ((thread, index)=>{
          let a = this.checkSubset(this.focused.group,thread.group);
          if (this.focused.procset == thread.procset && a){
            this.emit(event,index+1);
          }
        });
      }else{
        for (let i =1; i<=this.focused.group.length; i++){
          this.emit(event,i);
        }
      }
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
    return this.sendCommand('-gdb-exit');
  }

  private checkSubset(parentArray, subsetArray):boolean{
    return subsetArray.every((el) => {
        return parentArray.includes(el)
    })
  }

  public getThreads(): Promise<Thread[]> {    
    return new Promise(resolve => {
      this.sendCommand('-thread-info').then((record: Record) => {
        this.threads = [];
        const resultThreads: Thread[] = [];
        record.info?.get('msgs').forEach((message:any)=>{
          message['threads'].forEach((thread) => {
            let new_thread = {procset: message['proc_set'], group: this.getGroupArray(message['group']), id: parseInt(thread.id), name: message['proc_set']+message['group']+": "+parseInt(thread.id)};
            this.threads.push(new_thread);
          });
        }) 
        this.threads.forEach((thread, index)=>{
          resultThreads.push(new Thread(index+1, thread.name));
        });
        resolve(resultThreads);
      });
    });
  }

  public getVariable(name: string): Variable[] | undefined {
    let variable = this.findVariable(name);
    if (!variable){
      this.createVariable(name).then((v) => {
        return this.convertVariable(v);
      });
    }else{
      return this.convertVariable(variable);
    }
  }

  private findVariable(name: string): DbgVar | undefined {
    return this.variables.find((variable) => variable.name === name || variable.referenceName === name);
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
  private createVariable(name: string): Promise<DbgVar> {
    return new Promise(resolve => {
      this.sendCommand(`-var-create - * "${name}"`).then((recordVariable) => {
        let variables_match = this.parseVariableRecord(recordVariable.info!.get('value'));
        const numchild = parseInt(recordVariable.info!.get('numchild')) || parseInt(recordVariable.info!.get('has_more')) || 0;
        //create an array of values from mi message          
        
        let vals:any[]=[];
        variables_match.forEach(variable=>{
          vals.push({'procset':variable['procset'],'group':variable['group'],'value':variable['value']})
        });

        //create a new variable with all of the variations of values in one variable
        const newVariable: DbgVar = {
          name: name,
          referenceName: recordVariable.info!.get('name'),
          childNum: numchild,
          referenceID: numchild ? this.variables.length + 1 : 0, 
          type: recordVariable.info!.get('type'),
          values: vals
        };

        this.variables.push(newVariable);
        resolve(newVariable);
      });
    });
  }
  
  // send var-update command to gdb4hpc and get answer
  private updateVariables(): Promise<DbgVar[]> {
    return new Promise(resolve => {
      this.sendCommand(`-var-update --all-values *`).then((record:Record)=> {
        record.info?.get('changelist').forEach(variableRecord => {

          //get saved variable and update it
          let variable = this.findVariable(variableRecord.name);
          if (!variable) return resolve(this.variables)
          let variables_match = this.parseVariableRecord(variableRecord.value);
          variables_match.forEach(variable_match =>{
            //find saved variable corresponding to variable being updated from mi message
            let found = variable!.values.find(obj => {
              return obj.procset === variable_match['procset'] && obj.group === variable_match['group']
            });
            //if variable has a value stored for matching procset and group, update the value
            //otherwise add it
            if (found){
              found.value = variable_match['value']
            }else{
              variable!.values.push({'procset':variable_match['procset'],'group':variable_match['group'],'value':variable_match['value']})
            }
          })
          
          //filter out so any old variable values that were not updated
          variable!.values = variable!.values.filter((el) => {
            return variables_match.some((f) => {
              return f.procset === el.procset && f.group === el.group;
            });
          });
        });
        resolve(this.variables);
      });
    });
  }

  //Converts variable to the debug adapter variable
  private convertVariable(variable: DbgVar): Variable[]{
    const variables: Variable[] = [];
    if (variable){
      variable.values.forEach(val => {
        if (typeof val.value === 'string' && val.value) {
          val.value = val.value.replace(/\\r/g, ' ').replace(/\\t/g, '\t').replace(/\\v/g, '\v').replace(/\\"/g, '"')
                                    .replace(/\\'/g, "'").replace(/\\\\/g, '\\').replace(/\\n/g, ' ');
        }

        if(val.value){
          let name = variable.name+"("+val.procset+"{"+val.group+"})"
          const v: DebugProtocol.Variable = new Variable(name, val.value, variable.childNum ? variable.referenceID : 0, variable.referenceID);
          v.variablesReference = variable.referenceID;
          v.type = variable.type;
          variables.push(v);
        }
      });
    }
    return variables;
  }
  
  //get list of variables from gdb4hpc
  public getVariables(): Promise<Variable[]> {
    return new Promise(resolve => {
      this.sendCommand(`-stack-list-variables`).then((record: Record) => {
        const pending: Promise<DbgVar>[] = [];

        record.info?.get('variables').forEach(variable => {
          if (!this.findVariable(variable.name)){
            pending.push(this.createVariable(variable.name));
          }
        });

        Promise.all(pending).then(() => {
          this.updateVariables().then(()=>{
            let variables: Variable[] = [];
            this.variables.forEach(variable => {
              variables = [...variables,...this.convertVariable(variable)??[]];
            });
            resolve(variables);  
          });
        });
      });
    });
  }

  public stack(startFrame: number, endFrame: number): Promise<DebugProtocol.StackFrame[]> {
    return new Promise(resolve => {
      this.sendCommand(`-stack-list-frames`).then((record: Record) => {
        const stackFrame: DebugProtocol.StackFrame[] = [];
        let stack = record.info?.get('stack');
        for (let i = startFrame; i < Math.min(endFrame, stack.length); i++) {
          let frame = stack[i].frame;
          const sf: DebugProtocol.StackFrame = new StackFrame(i,frame.func,new Source(frame.file,frame.fullname),parseInt(frame.line));
          sf.instructionPointerReference = frame.addr;
          stackFrame.push(sf);
        }
        resolve(stackFrame);
      })
    });
	}

  public setBreakpoints(file: string, breakpoints: DebugProtocol.SourceBreakpoint[]): Promise<Breakpoint[]> {
    const pending: Promise<boolean>[] = [];
    
    //SetBreakpointRequest clears all breakpoints
    const clearBkpts = (file: string): Promise<boolean>=>{
      return new Promise(resolve => {
        const fileBkpts = this.breakpoints.filter(bkpt => {
          return bkpt.file == file;
        });
        fileBkpts.forEach((bkpt) => {
          this.sendCommand(`-break-delete ${bkpt.num}`);
        });
        this.breakpoints = this.breakpoints.filter(bkpt => {
          return bkpt.file != file;
        });
        resolve(true); 
      });
    }

    //Send Command to insert new breakpoint
    const insertBkpt = (file: string, line: number): Promise<any> =>{
      // XXX: setting breakpoint pending every time is a hack we have to do until CPE-6345 is implemented
      return this.sendCommand("-gdb-set breakpoint pending on")
        .then(() => this.sendCommand(`-break-insert ${file}:${line}`))
        .then((breakpoint: Record) => {
          const bkpt = breakpoint.info!.get('bkpt');
          if (!bkpt) return;
          this.breakpoints.push({num:parseInt(bkpt.number), bkpt:new Breakpoint(true, bkpt.line),file:file,line:bkpt.line})
      });
    }

    return new Promise(resolve => {
      //gdb4hpc needs to be connected and ready before breakpoints can be set
      if (this.appRunning){
        const intv = setInterval(() => {
          if (!this.appRunning) {
            clearInterval(intv);
            this.setBreakpoints(file, breakpoints).then(bps =>resolve(bps));
          }
        }, 100);
      }else{
        clearBkpts(file).then(() => {
          breakpoints.forEach(srcBkpt => pending.push(insertBkpt(file, srcBkpt.line)));
          Promise.all(pending).then(() => {
            const fileBkpts = this.breakpoints.filter(bkpt => {
              return bkpt.file == file;
            });
            resolve(fileBkpts.map(a => a.bkpt));
          });
        });
      }
    });
  }

  public addProcset(name: string, procset: string): Promise<boolean> {
    return new Promise(resolve => {
      this.sendCommand(`-procset-define $${name} ${procset}`);
      resolve(true)
    })
	}

  public getProcsetList(): Promise<Procset[]> {
    return new Promise(resolve => {
      this.sendCommand(`-procset-list`).then((record: Record) => {
        record.info?.get('pe_sets').forEach(set =>{
          if (!pe_list.some(pe => pe.name === set.name)){
            let selected = false;
            if (set.name == "all") selected = true;
            pe_list.push({name:set['name'], procset:set['proc_set'],isSelected:selected})
          }
        })
        resolve(pe_list);
      })  
    });
	}

  public changeFocus(i: number): Promise<boolean> {
    let pe_name = pe_list.at(i)?.name;
    return new Promise(resolve => {
      this.sendCommand(`-procset-focus $${pe_name}`).then((record: Record) => {
        let name = record.info?.get('focus')['name'];
        let found = false;
        pe_list.forEach((pe)=>{
          if (pe.name == name){
            pe.isSelected = true;
            let info = record.info?.get('focus')['proc_set'].split(/\{|\}/);
            this.focused.procset=info[0];
            this.focused.group = this.getGroupArray(info[1]);
            found = true;
          }else{
            pe.isSelected = false;
          }
        })
        resolve(found);
      })
    });
	}
  private getGroupArray(group:string):number[]{
    let g: number[] =[];
    group = group.replace(/\{|\}/g, '')
    group.split(',').forEach((item)=>{
      if (item.includes("..")){
        const [min,max]=item.split("..");
        for (var i = parseInt(min); i <= parseInt(max); i++) {
          g.push(i);
       }
      }else{
        g.push(parseInt(item))
      }
    })
    return g;
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
}
