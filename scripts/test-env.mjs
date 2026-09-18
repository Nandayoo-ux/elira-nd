console.log(Object.keys(process.env).filter(k => k.includes('KEY') || k.includes('ROUTER') || k.includes('API') || k.includes('DEEPSEEK')).map(k => `${k}=${process.env[k]}`).join('\n'));
