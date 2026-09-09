#!/usr/bin/env node
'use strict';
// Authoritative metrics boundary. The deployed service supplies one approved
// command (typically a read-only SQL adapter); snapshots remain test-only.
const {execFileSync}=require('child_process');
const fs=require('fs');
const command=process.env.BELT_COMPLETION_AUTHORITATIVE_METRICS_COMMAND;
try {
  if (!command) throw new Error('authoritative metrics adapter is not configured');
  const out=execFileSync('/bin/sh',['-c',command],{encoding:'utf8'});
  const data=JSON.parse(out);
  if (!data || (!data.workspace && !data.workspace_id)) throw new Error('authoritative metrics missing workspace');
  process.stdout.write(JSON.stringify(data));
} catch (e) {
  process.stderr.write(JSON.stringify({code:'belt_completion_metrics_unavailable',healthy:false,error:e.message}));
  process.exit(2);
}
