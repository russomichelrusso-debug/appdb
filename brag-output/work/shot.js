const {chromium}=require('/opt/node22/lib/node_modules/playwright');
(async()=>{
const times=process.argv.slice(2).map(Number);
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args:['--no-sandbox']});
const p=await b.newPage({viewport:{width:1920,height:1080}});
await p.goto('file://'+__dirname+'/scene.html');await p.evaluate(()=>document.fonts.ready);
for(const t of times){await p.evaluate(t=>render(t),t);await p.screenshot({path:`${__dirname}/still_${t.toFixed(2)}.png`});}
await b.close();})();
