const {spawn}=require('node:child_process');
const {existsSync}=require('node:fs');
const {resolve}=require('node:path');
const local=resolve('scene-worker',process.platform==='win32'?'.venv/Scripts/python.exe':'.venv/bin/python');
const executable=process.env.SCENE_PYTHON||(existsSync(local)?local:'python');
const worker=spawn(executable,['-m','zenatlas_scenes','--env-file','.env','work'],{stdio:'inherit',windowsHide:true});
worker.on('error',()=>{console.error('Scene worker could not start. Install scene-worker in its Python environment.');process.exitCode=1;});
worker.on('exit',code=>{process.exitCode=code??1;});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>worker.kill(signal));
