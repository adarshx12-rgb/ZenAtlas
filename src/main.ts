import { connect } from './db.js';
import { readConfig } from './config.js';
import { createApp } from './app.js';
const config=readConfig(); const db=connect(config.DATABASE_URL);
const app=await createApp(db,config);
await app.listen({host:config.HOST,port:config.PORT});
console.log(`Search service listening on ${config.HOST}:${config.PORT}`);
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>{void app.close().then(()=>db.close());});
