const { test } = require('brittle')
const LocalDrive = require('localdrive')
const { arch, platform, runtime } = require('which-runtime')

const DependencyStream = require('..')

test('imports work', async (t) => {
  const drive = new LocalDrive('./test/fixtures')

  const d = new DependencyStream(drive, {
    entrypoint: '.',
    packages: true,
    source: true
  })

  const resolutions = {}

  for await (const data of d) {
    for (const r of data.resolutions) {
      resolutions[r.input] = r
    }
  }

  t.is(resolutions['#env'].output, `/imports/${runtime}.js`)
  t.is(resolutions['#os'].output, `/imports/${platform}-${arch}.js`)
})
