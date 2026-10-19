import test from 'node:test';
import assert from 'node:assert/strict';
import {restoreDialogFocus} from '../../frontend/src/lib/dialog-focus.ts';

function fixture(){
 const doc={body:null as unknown,activeElement:null as unknown};
 const calls:string[]=[];
 function target(name:string,connected=true,acceptFocus=true){return {isConnected:connected,ownerDocument:doc,focus(){calls.push(name);if(this.isConnected&&acceptFocus)doc.activeElement=this;}};}
 const body=target('body');doc.body=body;doc.activeElement=body;
 return {doc,calls,target,body};
}

test('dialog close restores a still-mounted trigger without moving focus again',()=>{
 const f=fixture(),trigger=f.target('trigger'),workspace=f.target('workspace');
 restoreDialogFocus(trigger,workspace);
 assert.equal(f.doc.activeElement,trigger);assert.deepEqual(f.calls,['trigger']);
});

test('notification trigger removed by workspace navigation falls back to current content',()=>{
 const f=fixture(),trigger=f.target('old-notification',false),workspace=f.target('workspace');
 restoreDialogFocus(trigger,workspace);
 assert.equal(f.doc.activeElement,workspace);assert.deepEqual(f.calls,['workspace']);
});

test('body captured during an asynchronous open does not swallow focus restoration',()=>{
 const f=fixture(),workspace=f.target('workspace');
 restoreDialogFocus(f.body,workspace);
 assert.equal(f.doc.activeElement,workspace);assert.deepEqual(f.calls,['workspace']);
});

test('a connected trigger that cannot accept focus uses the workspace fallback',()=>{
 const f=fixture(),trigger=f.target('disabled-trigger',true,false),workspace=f.target('workspace');
 restoreDialogFocus(trigger,workspace);
 assert.equal(f.doc.activeElement,workspace);assert.deepEqual(f.calls,['disabled-trigger','workspace']);
});

test('close after workspace unmount does not focus a detached fallback',()=>{
 const f=fixture();restoreDialogFocus(f.target('old-trigger',false),f.target('old-workspace',false));
 assert.equal(f.doc.activeElement,f.body);assert.deepEqual(f.calls,[]);
});

test('missing trigger can recover to mounted content without requiring browser globals',()=>{
 const f=fixture(),workspace=f.target('workspace');restoreDialogFocus(null,workspace);
 assert.equal(f.doc.activeElement,workspace);assert.doesNotThrow(()=>restoreDialogFocus(null,null));
});
