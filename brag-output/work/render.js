const {chromium}=require('/opt/node22/lib/node_modules/playwright');
(async()=>{
const N=705;
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
const p=await b.newPage({viewport:{width:1920,height:1080}});
await p.goto('file://'+__dirname+'/scene.html');await p.evaluate(()=>document.fonts.ready);
await p.evaluate(()=>Promise.all([...document.images].map(i=>i.decode())));
for(let i=0;i<N;i++){await p.evaluate(t=>render(t),i/30);await p.screenshot({path:`${__dirname}/frames/f${String(i).padStart(4,'0')}.jpg`,type:'jpeg',quality:95});}
await b.close();})();
