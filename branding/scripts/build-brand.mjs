import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import sharp from 'sharp';
import * as fontkit from 'fontkit';

const root=fileURLToPath(new URL('../',import.meta.url));
const read=name=>fs.readFile(path.join(root,name));
const write=(name,data)=>fs.writeFile(path.join(root,name),data);
const reference=JSON.parse(await read('source/traced-reference.json'));
const needle=/ L 342\.981 118 .*? L 342\.947 117\.500 340\.911 113\.001/s;
const edgeSliver=/ M 0\.482 108 .*? M 177\.467 49\.800/s;
let markPath=reference.mark.paths[0];
if(!needle.test(markPath)||!edgeSliver.test(markPath))throw new Error('Expected tracing artefacts were not found; review source before editing.');
// Remove the two degenerate contours created at the tightly cropped bitmap edge.
// These are export artefacts, not changes to the chosen bird/R silhouette.
markPath=markPath.replace(needle,' L 343 118 L 340.911 113.001')
  .replace(edgeSliver,' M 177.467 49.800').replace('402.223','402')
  .replaceAll(' M ',' Z M ')+' Z';
await write('source/mark-path.json',JSON.stringify({viewBox:[0,0,343,402],path:markPath,correction:'Removed spurious beak-edge needle and left-edge sliver from the traced contour.'},null,2)+'\n');

const fontBytes=await read('source/Manrope-Variable.ttf');
const family=fontkit.create(fontBytes);
const bold=family.getVariation({wght:700});
const colors={ink:'#171A1D',ivory:'#F2F0EA',amber:'#D9A65C',amberText:'#80551D'};
const n=x=>Number(x.toFixed(4));
function lettering(text,font=bold){
  const run=font.layout(text);let pen=0,minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  const glyphs=run.glyphs.map((g,i)=>{const pos=run.positions[i],x=pen+pos.xOffset,y=pos.yOffset;
    if(g.path.commands.length){minX=Math.min(minX,x+g.bbox.minX);maxX=Math.max(maxX,x+g.bbox.maxX);minY=Math.min(minY,y+g.bbox.minY);maxY=Math.max(maxY,y+g.bbox.maxY);}
    pen+=pos.xAdvance;return `<path transform="translate(${n(x)} ${n(y)})" d="${g.path.toSVG()}"/>`;
  });
  return{width:maxX-minX,height:maxY-minY,paths:`<g transform="translate(${n(-minX)} ${n(maxY)}) scale(1 -1)">${glyphs.join('')}</g>`};
}
const word=lettering('Rookery');
const mark=(fill,x=0,y=0,scale=1)=>`<path fill="${fill}" fill-rule="evenodd" transform="translate(${n(x)} ${n(y)}) scale(${n(scale)})" d="${markPath}"/>`;
const wordAt=(fill,x,y,height)=>`<g fill="${fill}" transform="translate(${n(x)} ${n(y)}) scale(${n(height/word.height)})">${word.paths}</g>`;
const svg=(width,height,body,title='Rookery')=>`<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;
const markH=156,markW=343*markH/402,wordH=96,gap=34;
const lockupW=Math.ceil(markW+gap+word.width/word.height*wordH),lockupH=172;
const lockup=fill=>mark(fill,0,8,markH/402)+wordAt(fill,markW+gap,40,wordH);
for(const [suffix,color]of[['',colors.ink],['-light',colors.ivory]]){
  const logo=svg(lockupW,lockupH,lockup(color));
  await write(`logo${suffix}.svg`,logo);
  await write(`mark${suffix}.svg`,svg(343,402,mark(color)));
  await sharp(Buffer.from(logo),{density:300}).resize({width:1600}).png().toFile(path.join(root,`logo${suffix}.png`));
}
const icon=(round=true)=>svg(512,512,`<rect width="512" height="512" rx="${round?104:0}" fill="${colors.ink}"/>`+mark(colors.ivory,(512-343*0.88)/2,(512-402*0.88)/2,0.88));
await write('favicon.svg',icon());
await sharp(Buffer.from(icon(false))).resize(180,180).png().toFile(path.join(root,'apple-touch-icon.png'));
const frames=[];
for(const size of[16,32,48,256])frames.push({size,data:await sharp(Buffer.from(icon())).resize(size,size).png().toBuffer()});
const head=Buffer.alloc(6);head.writeUInt16LE(1,2);head.writeUInt16LE(frames.length,4);
let offset=6+frames.length*16;const entries=frames.map(({size,data})=>{const e=Buffer.alloc(16);e[0]=size===256?0:size;e[1]=e[0];e.writeUInt16LE(1,4);e.writeUInt16LE(32,6);e.writeUInt32LE(data.length,8);e.writeUInt32LE(offset,12);offset+=data.length;return e;});
await write('favicon.ico',Buffer.concat([head,...entries,...frames.map(x=>x.data)]));
await write('colors.css',`:root {\n  --rookery-ink: ${colors.ink};\n  --rookery-ivory: ${colors.ivory};\n  --rookery-amber: ${colors.amber};\n  /* Dunkler Akzent fuer lesbaren Text auf hellem Grund. */\n  --rookery-amber-text: ${colors.amberText};\n}\n`);
await write('colors.json',JSON.stringify(colors,null,2)+'\n');

const label=(text,x,y,height,fill)=>{const shape=lettering(text,family.getVariation({wght:500}));return`<g fill="${fill}" transform="translate(${x} ${y}) scale(${height/shape.height})">${shape.paths}</g>`;};
const preview=svg(1280,760,
 `<rect width="1280" height="760" fill="${colors.ivory}"/><rect x="720" width="560" height="760" fill="${colors.ink}"/>`+
 label('ROOKERY / 01',52,42,12,colors.amberText)+label('MANROPE 700',52,297,11,colors.amberText)+
 `<g transform="translate(52 99) scale(${600/lockupW})">${lockup(colors.ink)}</g>`+
 mark(colors.ink,58,341,0.38)+`<g transform="translate(289 374) scale(.16)"><rect width="512" height="512" rx="104" fill="${colors.ink}"/>${mark(colors.ivory,(512-343*.88)/2,(512-402*.88)/2,.88)}</g>`+
 label('Bildmarke',52,527,12,colors.ink)+label('Favicon',288,527,12,colors.ink)+
 mark(colors.ivory,914,139,.5)+wordAt(colors.ivory,804,402,94)+
 label('Ink',52,641,11,colors.ink)+label(colors.ink,52,666,10,colors.ink)+
 `<rect x="258" y="631" width="170" height="67" rx="3" fill="${colors.amber}"/>`+label('Amber',272,641,11,colors.ink)+label(colors.amber,272,666,10,colors.ink)+
 label('Ivory',496,641,11,colors.ink)+label(colors.ivory,496,666,10,colors.ink)+
 label('Ein Operator. Viele Agents.',804,663,14,colors.ivory),'Rookery: bereinigtes Logo und Farbpalette');
await sharp(Buffer.from(preview)).png().toFile(path.join(root,'preview.png'));
await write('source/wordmark.json',JSON.stringify({text:'Rookery',font:'Manrope',weight:700,kerning:'Native font layout',fontSha256:crypto.createHash('sha256').update(fontBytes).digest('hex'),unitsPerEm:bold.unitsPerEm,sourceBounds:{width:word.width,height:word.height},lockup:{width:lockupW,height:lockupH},method:'Typeset using the real variable font at weight 700; glyph outlines exported directly from font data. No raster tracing.'},null,2)+'\n');
console.log(JSON.stringify({status:'ok',font:'Manrope',weight:700,lockup:{width:lockupW,height:lockupH},removedArtefacts:2,publicFiles:12}));
