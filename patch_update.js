const fs = require('fs');
let code = fs.readFileSync('scripts/scrape.js', 'utf8');

const oldLine = 'allProgs.push({ programId: nextId, title: pi3.title || "", duration: pi3.duration || 0, updateTime: pi3.updateTime || null });';
const newLine1 = '          const sibItem = (pd3?.ProgramStore?.siblingPrograms || []).find(s => s.programId === nextId);\n          const ut = sibItem?.updateTime || allProgs[0]?.updateTime || "2022-03-01T08:44:50.000Z";\n          allProgs.push({ programId: nextId, title: pi3.title || "", duration: pi3.duration || 0, updateTime: ut });';

code = code.replace(oldLine, newLine1);
fs.writeFileSync('scripts/scrape.js', code);
console.log('UpdateTime patched');
