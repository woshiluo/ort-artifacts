import { exists } from 'https://deno.land/std@0.224.0/fs/mod.ts';
import { join } from 'https://deno.land/std@0.224.0/path/mod.ts';

import { cpus, platform } from 'node:os'; // is there really no deno-native function for this?

import { Command } from '@cliffy/command';
import $ from '@david/dax';

await new Command()
	.name('ort-artifact')
	.version('0.1.0')
	.option('-v, --upstream-version <version:string>', 'Exact version of upstream package', { required: true })
	.option('-c, --cuda', 'Enable CUDA EP')
	.action(async (options, ..._) => {
		const root = Deno.cwd();

		const onnxruntimeRoot = join(root, 'onnxruntime');
		if (!await exists(onnxruntimeRoot)) {
			await $`git clone https://github.com/microsoft/onnxruntime --recursive --single-branch --depth 1 --branch v${options.upstreamVersion}`;
		}

		$.cd(onnxruntimeRoot);

		const args = [];
		if (options.cuda) {
			args.push('-Donnxruntime_USE_CUDA=ON');
			args.push('-Donnxruntime_NVCC_THREADS=1');
			switch (platform()) {
				case 'linux': {
					const cudnnArchiveStream = await fetch(Deno.env.get('CUDNN_URL')!).then(c => c.body!);
					const cudnnOutPath = join(root, 'cudnn');
					await Deno.mkdir(cudnnOutPath);
					await $`tar xvJC ${cudnnOutPath} --strip-components=1 -f -`.stdin(cudnnArchiveStream);
					args.push(`-Donnxruntime_CUDNN_HOME=${cudnnOutPath}`);
					
					const trtArchiveStream = await fetch(Deno.env.get('TENSORRT_URL')!).then(c => c.body!);
					const trtOutPath = join(root, 'tensorrt');
					await Deno.mkdir(trtOutPath);
					await $`tar xvzC ${trtOutPath} --strip-components=1 -f -`.stdin(trtArchiveStream);
					args.push(`-Donnxruntime_TENSORRT_HOME=${trtOutPath}`);

					break;
				}
			}
		}

		await $`cmake -S cmake -B build -D CMAKE_BUILD_TYPE=Release -DCMAKE_CONFIGURATION_TYPES=Release -DCMAKE_INSTALL_PREFIX=${join(root, 'output')} -DONNXRUNTIME_SOURCE_DIR=${join(onnxruntimeRoot, 'cmake')} --compile-no-warning-as-error ${args}`;
		await $`cmake --build build --config Release --parallel ${cpus().length}`;
		await $`cmake --install build --config Release`;
	})
	.parse(Deno.args);
