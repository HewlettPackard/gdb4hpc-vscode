// Copyright 2025 Hewlett Packard Enterprise Development LP.

import { DebugProtocol } from '@vscode/debugprotocol';

export class DataStore {
  private variables = new Map<string,any>();
  private threads = new Map<string,any>();
  private stacks = new Map<string,any>();
  private status=new Map<string,any>();

  public setStatus(name:string,val:any,app?:string,group?:string){
    if(app){
      if(!this.status.get(name)){
        this.status.set(name,new Map<string,any>());
      }
      if(group){
        if(!this.status.get(name).get(app)){
          this.status.get(name).set(app,new Map<string,any>())
        }
        let values = this.status.get(name).get(app)
        this.updateValue(values,group,val)
      }
    }else{
      switch(name){
      case "breakpoints":
        console.warn("breakpoints")
        if(!this.status.get(name)){
          let breakpoints:DebugProtocol.Breakpoint[]=[];
          this.status.set(name,breakpoints)
        }
        this.status.get(name).push(val)
        break;
      default:
        this.status.set(name,val)
        break;
      }
    }
  }

  public getStatus(name:string,app?:string):any{
    let results:any[] = []
    if(app){
      if(!this.status.get(name).get(app)) return
      if(this.status.get(name).get(app).ranges){
        this.status.get(name).get(app).forEach(item=>{//for each variable rank,value pair
          let new_group=this.filterRange(item.ranges,this.status.get("groupFilter"))
          if(new_group){
            results.push(item.value)
          }
        })
        return results
      }else{
        return this.status.get(name).get(app);
      }
    }
    return this.status.get(name)
  }

  public removeFileBreakpoints(file:string):DebugProtocol.Breakpoint[]{
    console.warn("removeFileBreakpoints")
    if(!this.status.get("breakpoints")) return [];
    let removeBkpts=this.status.get("breakpoints")
    removeBkpts=removeBkpts.filter(bkpt => {
      return bkpt.source?.path == file;
    });
    console.warn("removeBkpts:",[...removeBkpts])
    let filtered = this.status.get("breakpoints")
    filtered=filtered.filter(bkpt => {
      return bkpt.source?.path != file;
    });
    this.status.set("breakpoints",filtered);
    console.warn("filteredBkpts:",[...filtered])
    return removeBkpts;
  }

  public addBreakpoint(bkpt:DebugProtocol.Breakpoint){
    let val = this.status.get("breakpoints")
    if(!val){
      this.status.set("breakpoints",new Array<DebugProtocol.Breakpoint>())
    }
    val=this.status.get("breakpoints")
    val.push(bkpt)
    console.warn("added bkpt:",[...val])
  }

  //set stack
  public setStack(startFrame:number,endFrame:number,message:any){
    console.warn("set stack:")
    let stackResults: DebugProtocol.StackFrame[] = [];
    let stack = message.stack
    for (let i = startFrame; i < Math.min(endFrame, stack.length); i++) {
      let frame = stack[i].frame;
      stackResults.push({id:i,name:frame.func,source:{name:frame.file,path:frame.fullname},
                line:parseInt(frame.line),column:0, instructionPointerReference:frame.addr});
    }

    if(!this.stacks.has(message.proc_set)) this.stacks.set(message.proc_set,new Map<string,any>());
    let values=this.stacks.get(message.proc_set)
    this.updateValue(values,message.group,stackResults.slice())
    console.warn("stack is set:",[...this.stacks.get(message.proc_set)])
  }

  public getStack(app:string,id:number):DebugProtocol.StackFrame[]{
    console.warn("getting stack:")
    //let threads:any[]=this.threads.has(app)?Array.from(this.threads.get(app)):[]
    //let request_group = threads?threads.find((item)=>item[1].id===id):[]
    //console.warn("request_group",request_group)
    let stacks = this.stacks.get(app)
    if(!stacks) return []
    let stackResults: DebugProtocol.StackFrame[] = [];
    stacks.forEach((value,key)=>{
      //let group_filter=this.filterRange(key,this.status.get("groupFilter"))
      //let thread_filter = this.filterRange(key,request_group)
      //let new_group = this.filterRange(group_filter,thread_filter)
      //if(thread_filter){
        const updatedValue = { ...value };
        stackResults.push(updatedValue);
      //}
    })
    console.warn("returning stack:",[...stackResults])
    return stackResults
  }

  //set threadlist
  public setThreads(app:string,message:any):DebugProtocol.Thread[]{
    console.warn("setting threads")
    let threads:DebugProtocol.Thread[] = [];

    if(!this.threads.has(message.proc_set)) this.threads.set(message.proc_set,new Map<string,any>());
    
    message.threads.forEach(thread=>{
      let new_thread = {id: this.threads.get(message.proc_set).size, 
        thread_id: parseInt(thread.id), name: message.proc_set+message.group+": "+parseInt(thread.id)};
      threads.push(new_thread)
    })

    if(!this.threads.has(message.proc_set)) this.threads.set(message.proc_set,new Map<string,any>());
    let values=this.threads.get(message.proc_set)
    this.updateValue(values,message.group,threads)

    console.warn("returning threads after setting:",threads)
    //only return if in app
    if (message.proc_set!=app) threads=[]
    return threads
  }

  public getThreads(app:string):DebugProtocol.Thread[]{
    let a =this.threads.get(app)
    let results:DebugProtocol.Thread[] = [];
    if (!a)return[]

    a.forEach((value,key)=>{//for each variable rank,value pair
      let new_group=this.filterRange(key,this.status.get("groupFilter"))
      if(new_group){
        const updatedValue = { ...value };
        results.push(updatedValue);
      }
    })
    return results;
  }

  //update Variable list
  public updateVars(variables:any):any{
    console.warn("updating vars")
    variables.forEach(variable_old=>{
      let variable ={...variable_old}
      if(!this.variables.get(variable.proc_set)){
        this.variables.set(variable.proc_set,new Map<string,any>());
      }
      let name = variable.hasOwnProperty("evaluateName")?variable.evaluateName:variable.name;
      if(!variable.hasOwnProperty("name")) variable["name"]=variable.evaluateName;
      if(!variable.hasOwnProperty("evaluateName")) variable["evaluateName"]=variable.name;
      if(!variable.hasOwnProperty("variableReference")) variable["variableReference"]=0;

      if(!this.variables.get(variable.proc_set).has(name)){
        this.variables.get(variable.proc_set).set(name,new Map<string,any>())
      }
      let values = this.variables.get(variable.proc_set).get(name)
      let v=this.createVar(variable.name,variable.evaluateName,variable.type,variable.variableReference,variable.value)
      this.updateValue(values,variable.group,v)
    });
    console.warn("updated vars",[...this.variables])
    return this.variables
  }

  //check if variable exists already
  public varExists(app:string,name:string){
    console.warn("var exists:",name,[...this.variables])
    return this.variables.get(app).has(name);
  }

  //get local variables for display
  public getLocalVariables(app:string):DebugProtocol.Variable[]{
    console.warn("getting local vars")
    const variables: DebugProtocol.Variable[] = [];
    let appVars = this.variables.get(app);
    if(appVars){
      appVars.forEach((variable)=>{ //for each variable
        variable.forEach((value,key)=>{//for each variable rank,value pair
          let new_group=this.filterRange(key,this.status.get("groupFilter"))
          if(new_group){
            const updatedValue = { ...value, name: value.name+"{"+new_group+"}" };
            variables.push(updatedValue);
          }
        })
      })
    }
    console.warn("returning local vars:",[...variables])
    return variables;
  }

  //create a variable
  private createVar(name:string, evaluateName:string, type:string, variableReference:number,value:any):DebugProtocol.Variable{
    console.warn("creating var")
    if (typeof value === 'string' && value) {
      value = value.replace(/\\r/g, ' ').replace(/\\t/g, '\t').replace(/\\v/g, '\v').replace(/\\"/g, '"')
                                .replace(/\\'/g, "'").replace(/\\\\/g, '\\').replace(/\\n/g, ' ');
    }
    const v: DebugProtocol.Variable = {name:name,type:type,evaluateName:evaluateName,variablesReference:variableReference,value:value};
    console.warn("created var:",v)
    return v;
  }

  public getCurrentSource(app:string):{line:number,file:string}{
    let displayRank:number = this.status.has("displayRank")?this.status.get("displayRank").get(app):0
    if(!this.status.has("source"))return {line:0,file:""}
    if(!this.status.get("source").has(app))return {line:0,file:""}
    let source:Map<string,any> = this.status.get("source").get(app)
    
    if(!displayRank) displayRank=0
    console.warn("display source:",source,displayRank)
    for(const key in source.keys()){
      console.warn("key:",key)
      if (this.filterRange(key,displayRank.toString())){
        return source.get(key)
      }
    }
    return {line:0,file:""}
  }

  private rangeToString(range:[number,number][]):string{
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
    let result:[number,number][]=[]
    range.replace(/\{|\}/g, "");
    const items = range.split(",")
    items.forEach((item)=>{
      if(item.includes('..')){
        const [start,end]=item.split('..').map(x=>parseInt(x))
        result.push([start,end])
      }else{
        result.push([parseInt(item),parseInt(item)])
      }
    })
    return result;
  }

  //from original range, get the left over after removing a specific range
  private removeRange(removeRanges:string,baseRanges:string){
    console.warn("removing range",removeRanges,baseRanges)
    let resultParts:[number,number][]=[]
    const removeRangeParts = this.parseRange(removeRanges)
    const baseRangeParts = this.parseRange(baseRanges)
    baseRangeParts.forEach(([baseStart,baseEnd])=>{
      removeRangeParts.forEach(([remStart,remEnd]) =>{
        if(remEnd<baseStart||remStart>baseEnd){
          resultParts.push([baseStart,baseEnd]);
          return;
        }
        if(remStart>baseStart) resultParts.push([baseStart,Math.min(baseEnd,remStart-1)]);
        if(remEnd<baseEnd) resultParts.push([Math.max(baseStart,remEnd+1),baseEnd]);
      })
    })

    let a = this.rangeToString(resultParts)
    console.warn("removing range done",a)
    return a;
  }

  //filter range1 constrained by range21..4,6   2..5,7
  private filterRange(range1:string,range2:string):string{
    console.warn("filterRange")
    let result: [number,number][]=[];
    const range1Parsed=this.parseRange(range1)
    const range2Parsed=this.parseRange(range2)
    range1Parsed.forEach(([start1,end1])=>{
      range2Parsed.forEach(([start2,end2])=>{
        const newStart = Math.max(start1,start2);
        const newEnd = Math.min(end1,end2);
        if(newStart<=newEnd){
          result.push([newStart,newEnd])
        }
      })
    })
    return this.rangeToString(result);
  }

  private updateValue(map:any,group:string, value:any){
    console.warn("in updateValues:",[...map])
    let results:{key:string,remaining:string,value:string}[]=[]
    map.forEach((val:any,key:string)=>{
      const remaining = this.removeRange(group,key)
      if(remaining!=""){
        if(remaining==group) return;
        results.push({key:key,remaining:remaining,value:val})
      }
      map.delete(key)
    })
    results.forEach((key,remaining,value)=>{
      map.set(remaining,value)
      map.delete(key)
    })
    map.set(group,value)
    console.warn("in updateValues updated:",[...map])
  }
}
