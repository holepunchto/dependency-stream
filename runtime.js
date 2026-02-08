exports.host = Bare.Addon.host
exports.conditions = ['bare', 'node', ...exports.host.split('-')]
exports.extensions = {
  module: ['.js', '.cjs', '.mjs', '.json', '.bare', '.node'],
  addon: ['.bare', '.node']
}
