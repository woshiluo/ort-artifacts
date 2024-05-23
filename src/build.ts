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
	.option('-t, --training', 'Enable Training API')
	.option('-s, --static', 'Build static library')
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
			args.push('-Donnxruntime_USE_TENSORRT=ON');
			args.push('-Donnxruntime_USE_TENSORRT_BUILTIN_PARSER=ON');
			// https://github.com/microsoft/onnxruntime/pull/20768
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
				case 'win32': {
					// windows should ship with bsdtar which supports extracting .zips
					const cudnnArchiveStream = await fetch(Deno.env.get('CUDNN_URL')!).then(c => c.body!);
					const cudnnOutPath = join(root, 'cudnn');
					await Deno.mkdir(cudnnOutPath);
					await $`tar xvC ${cudnnOutPath} --strip-components=1 -f -`.stdin(cudnnArchiveStream);
					args.push(`-Donnxruntime_CUDNN_HOME=${cudnnOutPath}`);
					
					const trtArchiveStream = await fetch(Deno.env.get('TENSORRT_URL')!).then(c => c.body!);
					const trtOutPath = join(root, 'tensorrt');
					await Deno.mkdir(trtOutPath);
					await $`tar xvC ${trtOutPath} --strip-components=1 -f -`.stdin(trtArchiveStream);
					args.push(`-Donnxruntime_TENSORRT_HOME=${trtOutPath}`);

					break;
				}
			}
		}

		if (options.training) {
			args.push('-Donnxruntime_ENABLE_TRAINING=ON');
			args.push('-Donnxruntime_ENABLE_LAZY_TENSOR=OFF');
			args.push('-Donnxruntime_DISABLE_RTTI=OFF');
		}

		const sourceDir = options.static ? join(root, 'src', 'static-build') : 'cmake';

		await $`cmake -S ${sourceDir} -B build -D CMAKE_BUILD_TYPE=Release -DCMAKE_CONFIGURATION_TYPES=Release -DCMAKE_INSTALL_PREFIX=${join(root, 'output')} -DONNXRUNTIME_SOURCE_DIR=${onnxruntimeRoot} --compile-no-warning-as-error ${args}`;
		await $`cmake --build build --config Release --parallel ${cpus().length}`;
		await $`cmake --install build --config Release`;
	})
	.parse(Deno.args);
