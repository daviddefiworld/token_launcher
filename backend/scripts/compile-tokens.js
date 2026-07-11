/**
 * Compiles every .sol file in src/skills/tokens/ into src/skills/tokenlaunch/compiled/.
 *
 * Output naming follows the solcjs CLI convention (<file>_sol_<Contract>.bin/.abi),
 * which is what contracts.ts expects. Each file is tried against every installed
 * compiler, newest first, so sources with older exact pragmas (e.g. Mystery.sol
 * pins 0.8.19) still build. Optimizer settings match `solcjs --optimize` (runs: 200).
 */
const fs = require('fs');
const path = require('path');

const TOKENS_DIR = path.join(__dirname, '..', 'src', 'skills', 'tokens');
const OUT_DIR = path.join(__dirname, '..', 'src', 'skills', 'tokenlaunch', 'compiled');

const COMPILERS = ['solc', 'solc0819'].map((mod) => require(mod));

function compile(solc, fileName, source) {
  const input = {
    language: 'Solidity',
    sources: { [fileName]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
  };
  return JSON.parse(solc.compile(JSON.stringify(input)));
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const files = fs
  .readdirSync(TOKENS_DIR)
  .filter((f) => f.endsWith('.sol'))
  .sort();

let failed = false;

for (const file of files) {
  const source = fs.readFileSync(path.join(TOKENS_DIR, file), 'utf8');
  let output = null;
  let errors = [];
  let usedVersion = null;

  for (const solc of COMPILERS) {
    const result = compile(solc, file, source);
    errors = (result.errors || []).filter((e) => e.severity === 'error');
    if (errors.some((e) => e.message.includes('requires different compiler version'))) {
      continue;
    }
    output = result;
    usedVersion = solc.version();
    break;
  }

  if (!output || errors.length > 0) {
    failed = true;
    console.error(`FAIL ${file}`);
    for (const e of errors) console.error(e.formattedMessage || e.message);
    continue;
  }

  const base = path.basename(file, '.sol');
  const written = [];
  for (const [name, contract] of Object.entries(output.contracts[file] || {})) {
    const bytecode = contract.evm.bytecode.object;
    if (!bytecode) continue; // interfaces and abstract contracts have no bytecode
    fs.writeFileSync(path.join(OUT_DIR, `${base}_sol_${name}.bin`), bytecode);
    fs.writeFileSync(path.join(OUT_DIR, `${base}_sol_${name}.abi`), JSON.stringify(contract.abi));
    written.push(name);
  }
  console.log(`OK   ${file} (solc ${usedVersion}) -> ${written.join(', ')}`);
}

process.exit(failed ? 1 : 0);
