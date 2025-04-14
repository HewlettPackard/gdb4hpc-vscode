// Copyright 2025 Hewlett Packard Enterprise Development LP.

import { DebugProtocol } from '@vscode/debugprotocol';

export type data ={
  app:string,
  group:[number,number][],
  name?:string,
  value:any
}

export class DataStore {
  private variables:data[] = [];
  private threads:data[] = [];
  private stacks:data[] = [];
  private status:data[]=[];
  private sourceBreakpoints : DebugProtocol.Breakpoint[] = [];
  private functionBreakpoints : DebugProtocol.Breakpoint[] = [];
  private threadCount:number=1;
  private sourceMap:{remote:string,local:string}[]=[];
  private firstRankThread:boolean=true;

  constructor(){
    this.setStatus("appRunning",false)
    this.setStatus("remote",false)
    this.setStatus("started",false)
    this.setStatus("focused",{name:"",procset:""});
  }

  public setStatus(name:string,val:any,app?:string,group?:string){
    if(!app){
      let item = this.status.find((item)=>item.name==name)
      item?item.value=val:this.status.push({name:name,value:val,app:"",group:[]})
      return;
    }
    if(!group){
      let item = this.status.find((item)=>item.name==name && item.app==app)
      item?item.value=val:this.status.push({name:name,value:val,app:app,group:[]})
      return;
    }
    let parsedGroup:[number,number][]=this.parseRange(group)
    this.updateArray(this.status,parsedGroup,app,val,name)
  }

  public getStatus(name:string):any{
    return this.status.find((item)=>item.name==name)?.value
  }

  public getStatusTree(name:string):data[]{
    return this.status.filter((item)=>item.name==name)
  }

  public removeSourceBreakpoints(file:string):DebugProtocol.Breakpoint[]{
    if(this.sourceBreakpoints.length<1) return []
    let removeBkpts=this.sourceBreakpoints.filter(bkpt => {
      return bkpt.source?.path == file;
    });
    this.sourceBreakpoints=this.sourceBreakpoints.filter(bkpt => {
      return bkpt.source?.path != file;
    });
    return removeBkpts;
  }

  public getFunctionBreakpoints():DebugProtocol.Breakpoint[]{
    return this.functionBreakpoints;
  }

  public addFunctionBreakpoints(bkpt:DebugProtocol.Breakpoint){
    this.functionBreakpoints.push(bkpt)
  }

  public removeFunctionBreakpoints() : DebugProtocol.Breakpoint[] {
    let removed = this.functionBreakpoints;
    this.functionBreakpoints = [];
    return removed;
  }

  
  public addSourceFile(remote:string,local:string){
    this.sourceMap.push({remote:remote,local:local})
  }

  public convertSourceFilePath(returnRemote:boolean,file:string){
    let found = this.sourceMap.find((item)=>item.remote==file||item.local==file)
    if(found){
      return returnRemote? found.remote : found.local
    }
    return ""
  }

  public getSourceBreakpoints():DebugProtocol.Breakpoint[]{
    return this.sourceBreakpoints
  }

  public addSourceBreakpoints(bkpt:DebugProtocol.Breakpoint){
    this.sourceBreakpoints.push(bkpt)
  }

  private stackFrameCount =0

  //set stack with new stack results
  public setStack(startFrame:number,endFrame:number,message:any):Promise<boolean>{
    return new Promise((resolve) => {
      let stackResults: DebugProtocol.StackFrame[] = [];
      let stack = message.stack
      for (let i = startFrame; i < Math.min(endFrame, stack.length); i++) {
        let frame = stack[i].frame; 
        if(!frame) continue;
        let sourceRef = this.getStatus("remote")?1:0;
        stackResults.push({id:this.stackFrameCount, name:frame.func, 
                  source:{name:frame.file, path:frame.file, sourceReference:sourceRef},
                  line:parseInt(frame.line), column:0, instructionPointerReference:frame.addr});
        this.stackFrameCount++;
      }
      this.updateArray(this.stacks,this.parseRange(message.group),message.proc_set,stackResults.slice())
      resolve(true)
    })
  }

  public getThreadStack(id:number):DebugProtocol.StackFrame[]{
    let thd=this.threads.find((thread)=>thread.value[0].id==id)
    if(!thd) return []
    let res = this.stacks.filter((stack)=>{
      if(stack.app!=thd.app) return false
      let new_group = this.filterRange(thd.group,stack.group)
      return (!new_group||(new_group&&new_group.length>0))
    })
   let results = res.flatMap((stack)=>stack.value)
    return results
  }

  //update threads 
  public setThreads(messages:any){
    if (!messages) return;
    messages.forEach((message)=>{
      let group_str:string=message.group.toString().replace(/\{|\}/g, "");
      let group_parts:[number,number][] = this.parseRange(group_str);
      let threads:DebugProtocol.Thread[] = [];
      message.threads.forEach((thread)=>{
        let name= message.proc_set+"{"+group_str+"}: "+parseInt(thread.id)
        let found_thread = this.threads.find((thread) => 
          thread.value.some((t: DebugProtocol.Thread) => t.name === name)
        );
        if(found_thread){
          threads.push(found_thread.value[0])
        }else{
          if (this.firstRankThread){
            let display = this.getStatus("sourceDisplay")
            let gr = this.filterRange(group_parts,this.parseRange(display.rank))
            if(display.app===message.proc_set && gr.length>0){
              threads.push({id:0,name:name})
              this.firstRankThread=false
            }
          } else {
            threads.push({id: this.threadCount, name: name})
            this.threadCount++;
          }
        }
        
      })
      this.updateArray(this.threads,group_parts,message.proc_set,threads)
    })
  }

  //retrieve threads for application
  public getThreads():data[]{
    return this.threads
  }

  //update Variable list
  public updateVars(variables:any):any{
    variables.forEach(variable_old=>{
      let variable ={...variable_old}
      let name = variable.hasOwnProperty("evaluateName")?variable.evaluateName:variable.name;
      if(!variable.hasOwnProperty("name")) variable["name"]=variable.evaluateName;
      if(!variable.hasOwnProperty("evaluateName")) variable["evaluateName"]=variable.name;
      if(!variable.hasOwnProperty("variableReference")) variable["variableReference"]=0;

      let vals = this.variables.filter((va)=> va.app==variable.app && va.name==variable.name)
      let v=this.createVar(variable.name,variable.evaluateName,variable.type,variable.variableReference,variable.value)
      if (vals){
        this.updateArray(this.variables,this.parseRange(variable.group),variable.proc_set,v,name)    
      } 
    });
    return this.variables
  }

  //check if variable exists already
  public varExists(name:string){
    return this.variables.find((variable)=>variable.name==name);
  }

  //get local variables for display
  public getLocalVariables():data[]{
    let res = this.filterGroupDisplay(this.variables)
    return res;
  }

  //get a value for a variable for evaluateRequest
  public getVariableValue(name:string):{value:string,variableReference:number}{
    let results: string[]=[];
    let found_variable = this.variables.filter((item)=>item.name==name)
    if(found_variable){
      found_variable.forEach((variable)=>{
        results.push(`${variable.app}{${this.rangeToString(variable.group)}}:${variable.value.toString()}\n`)
      })
    }
    return {value:results.join('\n'),variableReference:0}
  }

  //create a variable
  private createVar(name:string, evaluateName:string, type:string, variableReference:number,value:any):DebugProtocol.Variable{
    if (typeof value === 'string' && value) {
      value = value.replace(/\\r|\\n|\\v/g, ' ').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    }
    const v: DebugProtocol.Variable = {name:name,type:type,evaluateName:evaluateName,variablesReference:variableReference,value:value};
    return v;
  }

  //converts a range value to string
  public rangeToString(range:[number,number][]):string{
    let result:string[]=[]
    range.forEach(([start,end])=>{
      if(start==end){
        result.push(start.toString())
      }else{
        result.push(`${start}..${end}`)
      }
    })
    return result.join(",");
  }

  public parseRange(range:string):[number,number][]{
    if(!range) return [];
    range=range.replace(/\{|\}/g, "");
    let result:[number,number][]=[]
    const items = range.split(",")
    items.forEach((item)=>{
      if(item.includes('..')){
        const [start,end]=item.split('..').map(x=>parseInt(x))
        result.push([start,end])
      }else{
        let itm = parseInt(item)
        result.push([itm,itm])
      }
    })
    return result;
  }

  //if values for different ranks are updating, 
  // remove the ranks that are being updated
  //and keep the value for the old ranks that didn't change
  //i.e. if ranks 1..4 = "a" and then rank 2 gets updated to "b"
  //rank 2 gets removed from 1..4 to create
  // ranks 1,3..4="a" and rank 2="b"
  private removeRange(removeRangeParts:[number,number][],baseRangeParts:[number,number][]):[number,number][]{
    let resultParts:[number,number][]=[]
    let j=0;
    if(this.rangeToString(removeRangeParts)==this.rangeToString(baseRangeParts)) return resultParts
    for (let i=0;i<baseRangeParts.length;i++) {
      let [bmin,bmax]=baseRangeParts[i]
      while(bmin<=bmax&&j<removeRangeParts.length){
        let [rmin,rmax]=removeRangeParts[j]
        if(rmax<bmin){
          j++;
          continue;
        }else if(rmin>bmax){
          break;
        }else if(rmin<=bmax){
          (rmin>bmin)?resultParts.push([bmin,rmin-1]):null;
          bmin=rmax+1
        }
      }
      if(bmin<=bmax)resultParts.push([bmin,bmax]);
    }
    return resultParts;
  }

  //filter what to show for groupFilter/sourceDisplay
  public filterSourceDisplay(data:data[]): data | undefined{
    let display = this.getStatus("sourceDisplay")
    let res = data.find((thread)=>this.filterRange(thread.group,this.parseRange(display.rank)))
    return res
  }

  //filter what to show for groupFilter
  public filterGroupDisplay(data:data[]):data[]{
    let group_filter = this.getStatusTree("groupFilter")
    let res = data.filter((item)=>{
      if(!item.group) return false
      const filter=group_filter.find((filter)=>filter.app===item.app)
      if(filter){
        let new_group = this.filterRange(item.group,filter.group)
        return (new_group&&new_group.length>0)
      }
      return false
    })
    return res
  }
  
  //returns if two ranges have overlap ie (1..4,6)   (2..5,7)  = (2..4)
  //mostly used for filtering in vscode by ranks
  private filterRange(range1Parsed:[number,number][],range2Parsed:[number,number][]):[number,number][]{
    let result: [number,number][]=[];
    let r1 = 0
    let r2 = 0
    while(r1<range1Parsed.length&&r2<range2Parsed.length){
      let [start1,end1]=range1Parsed[r1]
      let [start2,end2]=range2Parsed[r2]
      const newStart = Math.max(start1,start2)
      const newEnd = Math.min(end1,end2)
      if(newStart<=newEnd){
        result.push([newStart,newEnd])
      }
      end1<end2?r1++:r2++
    }
    return result;
  }

  //update map in preparation for adding new values
  private updateArray(array:data[],group:[number,number][],app:string,value:any,name?:string){
    let filtered = array.filter((element)=>(app?element.app==app:true)&&(name?element.name==name:true))
    let remaining = group
    for(const item of filtered){
      remaining=this.removeRange(group,item.group)
      if(remaining.length==0){
        item.value = value;
        break;
      }else if(remaining!=item.group){
        item.group = remaining
      }
    }
    if(remaining.length==0) return;
    name?array.push({name:name,value:value,app:app,group:group}):array.push({value:value,app:app,group:group})
  }
}
