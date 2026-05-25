const fs = require('fs');
const code = fs.readFileSync('scripts/scrape.js', 'utf8');

const sortValidate = `
  // Sort by episode number
  allProgs.sort((a,b) => {
    const gn = t => { const m=(t||'').match(/第(\\d+)集/); return m ? parseInt(m[1]) : Infinity; };
    return gn(a.title) - gn(b.title);
  });
  
  // Dedup
  const seenSet = new Set();
  const deduped = allProgs.filter(p => { const k = p.programId; if (seenSet.has(k)) return false; seenSet.add(k); return true; });
  if (deduped.length !== allProgs.length) console.log('  Removed ' + (allProgs.length-deduped.length) + ' duplicates');
  allProgs.length = 0; allProgs.push(...deduped);
  
  // Gap check
  const nums = allProgs.map(p => { const m = (p.title||'').match(/第(\\d+)集/); return m ? parseInt(m[1]) : null; }).filter(n => n !== null);
  if (nums.length > 0) {
    let gaps = 0;
    for (let i = 0; i < nums.length; i++) {
      if (nums[i] !== nums[0] + i) gaps++;
    }
    if (gaps > 0) console.log('  Warning: ' + gaps + ' sequence gaps');
    else console.log('  Sequence OK: ' + nums[0] + ' ~ ' + nums[nums.length-1]);
  }
`;

const target = "console.log('Total: ' + allProgs.length + ' eps (walked ' + walked + ')');";
const modified = code.replace(target, target + sortValidate);

fs.writeFileSync('scripts/scrape.js', modified);
console.log('Done');
