import { RuleCreator } from '@typescript-eslint/utils/eslint-utils';
import path from 'path';
import fs from 'fs';
import { Worker, MessageChannel, receiveMessageOnPort } from 'worker_threads';
import semver from 'semver';
export { ESLintUtils } from '@typescript-eslint/utils';
import { getExportInfo, getRuntimeExports } from './utils';
import { Exports } from '@grafana/levitate';
import ts from 'typescript';

const pluginJson = require(process.cwd() + '/src/plugin.json');
const minVersion = semver.minVersion(pluginJson.dependencies.grafanaDependency);

const { port1: localPort, port2: workerPort } = new MessageChannel();
const shared = new SharedArrayBuffer(4);
const workerData = { shared, port: workerPort };
// the bundle does currently not include the worker module, so this is a temporary workaround for that
const workerFile = fs.existsSync(path.join(__dirname, '/rules/installPackages.js'))
  ? '/rules/installPackages.js'
  : '/installPackages.js';
new Worker(path.join(__dirname, workerFile), {
  workerData,
  transferList: [workerPort],
});
const int32 = new Int32Array(shared);
console.log(`Installing version ${minVersion} of grafana packages...`);
Atomics.wait(int32, 0, 0);

const { packagePaths, message }: { packagePaths: Record<string, string>; message: string } =
  receiveMessageOnPort(localPort)?.message;
console.log(message);

const packageExports: Record<string, { exports: Exports; program: ts.Program }> = {};
Object.entries(packagePaths).forEach(([pkg, path]) => {
  packageExports[pkg] = getExportInfo(path);
});

export const createRule = RuleCreator((name) => `https://my-website.io/eslint/${name}`);

type MessageIds = 'issue:import';
export const importExists = createRule<[], MessageIds>({
  name: 'import-exists',
  meta: {
    docs: {
      description: 'An example ESLint rule',
    },
    hasSuggestions: true,
    messages: {
      'issue:import':
        'The member "{{member}}" is not available in all runtime environments that this plugin supports. Make sure to check if the member is undefined before accessing it, or it may cause runtime errors. "{{package}}" does not export member "{{member}}".',
    },
    schema: [
      {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    ],
    type: 'suggestion',
  },
  defaultOptions: [],
  create: (context) => {
    return {
      ImportSpecifier: async (node) => {
        if (node?.imported?.name) {
          // @ts-ignore
          const identifier = node.parent.source.value;
          if (identifier in packageExports && Object.keys(packageExports[identifier].exports).length > 0) {
            const exportsExceptTypesAndInterfaces = getRuntimeExports(packageExports[identifier].exports);
            if (!exportsExceptTypesAndInterfaces.includes(node.imported.name)) {
              context.report({
                node,
                data: { member: node.imported.name, package: `${identifier}@${minVersion}` },
                messageId: 'issue:import',
              });
            }
          }
        }
      },
    };
  },
});
