for (const name of Object.keys(process.env)
  .filter(name => /KEY|ROUTER|API|DEEPSEEK/i.test(name)).sort()) {
  console.log(`${name}=<present>`)
}
