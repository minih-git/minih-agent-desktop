#!/usr/bin/env node
/** Isolated production TranscriptProse interaction; no provider or user profile. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "apps/desktop/package.json"));
const { build } = require("esbuild");
const temp = await mkdtemp(join(process.env.PI_SCRATCH_DIR ?? root, "transcript-prose-"));
try {
  await build({ stdin: { sourcefile: "prose-fixture.tsx", resolveDir: root, loader: "tsx", contents: `
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { en } from "@minih-agent/i18n";
import { TranscriptProse } from "./apps/desktop/src/features/chat/transcript/TranscriptProse";
import { ScopeContext } from "./apps/desktop/src/features/chat/transcript/disclosure-scope";
const i18n = createInstance();
await i18n.init({lng:"en", resources:{en:{translation:en}}});
const host = document.getElementById("root");
const root = createRoot(host);
document.documentElement.dataset.theme = "light";
let visible = true;
const prose = "A readable paragraph with inline code and a stable message anchor. ".repeat(24);
const code = "\x60\x60\x60js\\nconst answer = 42;\\n\x60\x60\x60";
const html = "<html><body><h1>Retained preview</h1></body></html>";
function App() { return <I18nextProvider i18n={i18n}>
  <nav><button id="top" onClick={()=>document.querySelector(".thread-scroll").scrollTo({top:0})}>Earlier messages</button>
  <button id="bottom" onClick={()=>{ const el=document.querySelector(".thread-scroll"); el.scrollTo({top:el.scrollHeight}); }}>Latest messages</button>
  <button id="visibility" onClick={()=>{visible=!visible; render();}}>Hide / show reading pane</button></nav>
  <h1>Transcript reading regression</h1>
  <ScopeContext.Provider value={{visible,claim:()=>{},reveal:()=>{}}}>
  <div className="thread-scroll" style={{height:400,overflowY:"auto",overflowAnchor:"none",visibility:visible?"visible":"hidden"}}>
    <div data-rich="code"><TranscriptProse source={code} streaming={false}/></div>
    <div data-rich="html"><TranscriptProse source={html} streaming={false}/></div>
    {Array.from({length:32},(_,n)=><section key={n} data-row={n}><TranscriptProse source={"Message "+n+"\\n\\n"+prose} streaming={false}/></section>)}
  </div></ScopeContext.Provider>
</I18nextProvider> }
function render(){flushSync(()=>root.render(<App/>));} render();
const frame=()=>new Promise(resolve=>requestAnimationFrame(resolve));
globalThis.waitProse=async(test)=>{for(let n=0;n<240;n++){if(test())return;await frame();}throw new Error("Prose condition did not settle");};
globalThis.proseNodes={code:document.querySelector('[data-rich="code"] .prose-chat'),html:document.querySelector('[data-rich="html"] .prose-chat')};
globalThis.teardownProse=()=>root.unmount();
` }, outfile: join(temp, "renderer.js"), bundle: true, platform: "browser", format: "esm", jsx: "automatic",
    loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"', "import.meta.env": JSON.stringify({DEV:false,MODE:"production"}) },
    alias: {react:join(root,"apps/desktop/node_modules/react"),"react-dom":join(root,"apps/desktop/node_modules/react-dom")},
    plugins: [{name:"url-assets",setup(b){b.onResolve({filter:/\?url$/},({path,resolveDir})=>({path:join(resolveDir,path.slice(0,-4)),namespace:"asset"}));b.onLoad({filter:/.*/,namespace:"asset"},async({path})=>({contents:await readFile(path),loader:"file"}));}}],
    nodePaths:[join(root,"apps/desktop/node_modules")],
  });
  const renderer = join(root,"apps/desktop/out/renderer");
  const html = await readFile(join(renderer,"index.html"),"utf8");
  const css = [...html.matchAll(/href="([^" ]+\.css)"/g)].map(match=>match[1]);
  assert(css.length,"Build Desktop before running this check");
  await cp(join(renderer,"assets"),join(temp,"assets"),{recursive:true});
  await writeFile(join(temp,"index.html"),`<!doctype html><meta charset="utf-8">${css.map(path=>`<link rel="stylesheet" href="${path}">`).join("")}<style>body{margin:0;padding:24px;font:14px system-ui;background:#fafafa}nav{display:flex;gap:12px}button{padding:8px 14px;border:1px solid #bbb;border-radius:6px}h1{font-size:20px;margin:16px 0}.thread-scroll{border:1px solid #ccc;background:white}section,[data-rich]{padding:20px;border-bottom:1px solid #eee}</style><div id="root"></div><script type="module" src="renderer.js"></script>`);
  await writeFile(join(temp,"main.cjs"),String.raw`
const {app,BrowserWindow}=require("electron");
const path=require("node:path");const fs=require("node:fs/promises");
app.setPath("userData",path.join(__dirname,"profile"));
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1000,height:650,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
const run=code=>win.webContents.executeJavaScript(code);
const check=(value,message)=>{if(!value)throw new Error(message)};
const click=async(id)=>{const point=await run('(()=>{const r=document.getElementById('+JSON.stringify(id)+').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');win.webContents.sendInputEvent({type:"mouseDown",button:"left",clickCount:1,...point});win.webContents.sendInputEvent({type:"mouseUp",button:"left",clickCount:1,...point});};
try{await win.loadFile(path.join(__dirname,"index.html"));await run('waitProse(()=>Boolean(globalThis.proseNodes))');
await click("bottom");await run('waitProse(()=>document.querySelector(".thread-scroll").scrollTop>1000&&document.querySelectorAll(\'[data-transcript-content="placeholder"]\').length>0)');
check(await run('proseNodes.code===document.querySelector(\'[data-rich="code"] .prose-chat\')&&proseNodes.code.firstElementChild!==null&&proseNodes.html.firstElementChild!==null'),"stateful content was recycled");
await click("top");await run('waitProse(()=>document.querySelector(".thread-scroll").scrollTop===0&&document.querySelector(\'[data-row="0"] p\'))');
await run('(()=>{const text=document.querySelector(\'[data-row="0"] p\').firstChild;const range=document.createRange();range.setStart(text,0);range.setEnd(text,Math.min(7,text.length));getSelection().removeAllRanges();getSelection().addRange(range)})()');
await click("bottom");await run('waitProse(()=>document.querySelector(".thread-scroll").scrollTop>1000)');
check(await run('document.querySelector(\'[data-row="0"] [data-transcript-content]\').dataset.transcriptContent==="mounted"'),"selected prose was recycled");
await click("visibility");await click("visibility");check(await run('proseNodes.code===document.querySelector(\'[data-rich="code"] .prose-chat\')&&proseNodes.html.firstElementChild!==null'),"hide/show lost rich renderer state");
await click("top");await run('getSelection().removeAllRanges();document.dispatchEvent(new Event("selectionchange"))');
win.webContents.sendInputEvent({type:"mouseWheel",x:500,y:400,deltaY:-600,deltaX:0,canScroll:true});
await run('waitProse(()=>document.querySelector(\'[data-row="0"] p\'))');
const image=await win.webContents.capturePage();await fs.writeFile(path.join(process.env.PI_SCRATCH_DIR||__dirname,"transcript-prose.png"),image.toPNG());
await run('teardownProse()');console.log("PROSE_RESULT "+JSON.stringify({ok:true,checks:["native pointer scroll controls","measured prose recycling","code and HTML retention","selection protection","hidden pane retention","wheel input","cleanup"]}));app.exit(0);
}catch(error){console.error(error.stack);app.exit(1)}});`);
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  execFileSync(process.execPath, ["--check", join(temp, "main.cjs")], { stdio: "pipe" });
  const child=spawn(resolveElectronBinary(root).electronBinary,[join(temp,"main.cjs")],{env,stdio:["ignore","pipe","pipe"]});
  let output="";for(const stream of [child.stdout,child.stderr])stream.on("data",data=>{output+=data;});
  const timer=setTimeout(()=>child.kill("SIGKILL"),45000);
  const code=await new Promise((resolve,reject)=>{child.once("error",reject);child.once("close",resolve);}).finally(()=>clearTimeout(timer));
  console.log(output.split(/\r?\n/).find(line=>line.startsWith("PROSE_RESULT "))??output.slice(-4000));
  assert.equal(code,0,output.slice(-4000));
} finally { await rm(temp,{recursive:true,force:true}); }
