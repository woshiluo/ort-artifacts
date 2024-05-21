import { exists,  } from 'https://deno.land/std@0.224.0/fs/mod.ts';
import { join } from 'https://deno.land/std@0.224.0/path/mod.ts';

import { cpus, platform } from 'node:os'; // is there really no deno-native function for this?

import { Command } from '@cliffy/command';
import $ from '@david/dax';

const TRT_LINUX_PKG = 'https://developer.nvidia.com/downloads/compute/machine-learning/tensorrt/10.0.1/tars/TensorRT-10.0.1.6.Linux.x86_64-gnu.cuda-12.4.tar.gz';
const TRT_WINDOWS_PKG = 'https://developer.nvidia.com/downloads/compute/machine-learning/tensorrt/10.0.1/zip/TensorRT-10.0.1.6.Windows10.win10.cuda-12.4.zip';
const CUDNN_LINUX_PKG = 'https://developer.nvidia.com/downloads/compute/cudnn/secure/8.9.7/local_installers/12.x/cudnn-linux-x86_64-8.9.7.29_cuda12-archive.tar.xz';
const CUDNN_WINDOWS_PKG = 'https://developer.nvidia.com/downloads/compute/cudnn/secure/8.9.7/local_installers/12.x/cudnn-windows-x86_64-8.9.7.29_cuda12-archive.zip';

await new Command()
	.name('ort-artifact')
	.version('0.1.0')
	.option('-v, --upstream-version <version:string>', 'Exact version of upstream package', { required: true })
	.option('-c, --cuda', 'Enable CUDA EP')
	.action(async (options, ..._) => {
		const root = Deno.cwd();

		const onnxruntimeRoot = join(root, 'onnxruntime');
		if (await exists(onnxruntimeRoot)) {
			console.log(`Cleaning up ${onnxruntimeRoot}`);
			await Deno.remove(onnxruntimeRoot, { recursive: true });
		}

		await $`git clone https://github.com/microsoft/onnxruntime --recursive --single-branch --depth 1 --branch v${options.upstreamVersion}`;

		$.cd(onnxruntimeRoot);

		const args = [];
		if (options.cuda) {
			args.push('-Donnxruntime_USE_CUDA=ON');
			switch (platform()) {
				case 'linux': {
					const cudnnArchiveStream = await fetch(CUDNN_LINUX_PKG).then(c => c.body!);
					const cudnnOutPath = join(root, 'cudnn');
					await $`tar xJf - -C ${cudnnOutPath}`.stdin(cudnnArchiveStream);
					args.push(`-Donnxruntime_CUDNN_HOME=${cudnnOutPath}`);
					
					const trtArchiveStream = await fetch(TRT_LINUX_PKG).then(c => c.body!);
					const trtOutPath = join(root, 'tensorrt');
					await $`tar xzf - -C ${trtOutPath}`.stdin(trtArchiveStream);
					args.push(`-Donnxruntime_TENSORRT_HOME=${trtOutPath}`);

					break;
				}
			}
		}

		await $`cmake -S . -B build -D CMAKE_BUILD_TYPE=Release -DCMAKE_CONFIGURATION_TYPES=Release -DCMAKE_INSTALL_PREFIX=${join(root, 'output')} -DONNXRUNTIME_SOURCE_DIR=${onnxruntimeRoot} --compile-no-warning-as-error ${args}`;
		await $`cmake --build build --config Release --parallel ${cpus().length}`;
		await $`cmake --install build --config Release`;
	})
	.parse(Deno.args);
