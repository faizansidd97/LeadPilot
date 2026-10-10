import {test} from 'node:test';
import assert from 'node:assert/strict';
import {operationsSnapshotSchema,operationsAlertLabels} from '../src/domain/operations.ts';
const snapshot={captured_at:'2026-10-08T10:00:00+00:00',lag_alert_seconds:900,reminders:{awaiting_creation:0,oldest_due_seconds:0},notifications:{pending:0,running:0,failed:0,expired_leases:0,oldest_pending_seconds:0},ai:{queued:0,running:0,failed:0,expired_leases:0,oldest_pending_seconds:0,reconciliation:0},alerts:[],cost_amount:null,scheduler_verified:false};
test('operations projection supports empty snapshots without asserting live delivery or reconciled cost',()=>{
 assert.deepEqual(operationsSnapshotSchema.parse(snapshot),snapshot);assert.equal(operationsSnapshotSchema.safeParse({...snapshot,scheduler_verified:true}).success,false);assert.equal(operationsSnapshotSchema.safeParse({...snapshot,cost_amount:0}).success,false);
});
test('operations contract excludes customer/worker payloads, unsafe counters and unknown alert messages',()=>{
 for(const extra of [{tenant_id:crypto.randomUUID()},{jobs:[{email:'private@example.test'}]},{captured_at:'bad'},{lag_alert_seconds:60},{alerts:['PRIVATE_ERROR_TEXT']},{alerts:Array(8).fill('FAILED_AI_JOBS')},{ai:{...snapshot.ai,queued:-1}},{notifications:{...snapshot.notifications,running:1.5}},{reminders:{...snapshot.reminders,awaiting_creation:Number.MAX_SAFE_INTEGER+1}},{ai:{...snapshot.ai,prompt:'Private'}}])assert.equal(operationsSnapshotSchema.safeParse({...snapshot,...extra}).success,false);
 assert.equal(Object.keys(operationsAlertLabels).length,7);for(const label of Object.values(operationsAlertLabels))assert.ok(label.length>10);
});
