import {workOne} from '../lib/worker';import {database} from '../lib/db';
let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
async function lane(){while(!stopping){try{const active=await workOne();if(!active)await new Promise(r=>setTimeout(r,1500));}catch{console.error('WORKER_CYCLE_FAILED');await new Promise(r=>setTimeout(r,5000));}}}
await database().query("UPDATE nota_app.jobs SET status='NEEDS_REVIEW',error_code='STALE_EXECUTION',updated_at=now() WHERE status='RUNNING' AND updated_at<now()-interval '15 minutes'");
const cleanup=setInterval(()=>{database().query("UPDATE nota_app.jobs SET status='NEEDS_REVIEW',error_code='STALE_EXECUTION',updated_at=now() WHERE status='RUNNING' AND updated_at<now()-interval '15 minutes'").catch(()=>{});},60000);
console.log('OCR_WORKER_READY concurrency=2');await Promise.all([lane(),lane()]);clearInterval(cleanup);await database().end();
