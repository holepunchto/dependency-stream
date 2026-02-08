exports.host = `${process.platform}-${process.arch}`
// bare first module
exports.conditions = ['bare', 'node', ...exports.host.split('-')]
exports.extensions = { module: ['.js', '.json', '.node'], addon: ['.node'] }
