'use strict';

// Prints package.json adjusted for the Volumio 4 (bookworm) plugin store, as required by
// https://github.com/volumio/volumio-plugins-sources-bookworm. Usage:
//   node scripts/bookworm.js > <fork>/sverigesradio/package.json

const pkg = require('../package.json');

pkg.volumio_info.os = ['bookworm'];
pkg.volumio_info.architectures = ['amd64', 'armhf'];
pkg.engines = { node: '>=20', volumio: '>=4' };
delete pkg.scripts.package;
delete pkg.scripts.bookworm;

process.stdout.write(JSON.stringify(pkg, null, 2) + '\n');
