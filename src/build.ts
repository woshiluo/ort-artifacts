import { exists } from 'https://deno.land/std@0.224.0/fs/mod.ts';
import { join } from 'https://deno.land/std@0.224.0/path/mod.ts';

import { arch as getArch, cpus, platform as getPlatform } from 'node:os';

import { Command, EnumType } from '@cliffy/command';
import $ from '@david/dax';

const arch: 'x64' | 'arm64' = getArch();
const platform: 'win32' | 'darwin' | 'linux' = getPlatform();

const TARGET_ARCHITECTURE_TYPE = new EnumType([ 'x86_64', 'aarch64' ]);

await new Command()
	.name('ort-artifact')
	.version('0.1.0')
	.type('target-arch', TARGET_ARCHITECTURE_TYPE)
	.option('-v, --upstream-version <version:string>', 'Exact version of upstream package; defaults to main branch')
	.option('-t, --training', 'Enable Training API')
	.option('-s, --static', 'Build static library')
	.option('--cuda', 'Enable CUDA EP')
	.option('--trt', 'Enable TensorRT EP', { depends: [ 'cuda' ] })
	.option('--directml', 'Enable DirectML EP')
	.option('--coreml', 'Enable CoreML EP')
	.option('--xnnpack', 'Enable XNNPACK EP')
	.option('--rocm', 'Enable ROCm EP')
	.option('--webgpu', 'Enable WebGPU EP')
	.option('-A, --arch <arch:target-arch>', 'Configure target architecture for cross-compile', { default: 'x86_64' })
	.option('-W, --wasm', 'Compile for WebAssembly (with patches)')
	.option('--emsdk <version:string>', 'Emsdk version to use for WebAssembly build', { default: '3.1.59' })
	.action(async (options, ..._) => {
		const root = Deno.cwd();

		const onnxruntimeRoot = join(root, 'onnxruntime');
		if (!await exists(onnxruntimeRoot)) {
			let branch = options.upstreamVersion === undefined || options.upstreamVersion === "main" ? "main" : `rel-${options.upstreamVersion}`;
			await $`git clone https://github.com/microsoft/onnxruntime --recursive --single-branch --depth 1 --branch ${branch}`;
		}

		$.cd(onnxruntimeRoot);

		await $`git reset --hard HEAD`;
		await $`git clean -fd`;

		const patchDir = join(root, 'src', 'patches', 'all');
		for await (const patchFile of Deno.readDir(patchDir)) {
			if (!patchFile.isFile) {
				continue;
			}

			await $`git apply ${join(patchDir, patchFile.name)} --ignore-whitespace --recount --verbose`;
			console.log(`applied ${patchFile.name}`);
		}

		if (options.wasm) {
			// there's no WAY im gonna try to wrestle with CMake on this one
			await $`bash ./build.sh --config Release --build_wasm_static_lib --enable_wasm_simd --enable_wasm_threads --skip_tests --disable_wasm_exception_catching --disable_rtti --parallel --emsdk_version ${options.emsdk}`;

			const buildRoot = join(onnxruntimeRoot, 'build', 'Linux', 'Release');

			const artifactOutDir = join(root, 'artifact');
			await Deno.mkdir(artifactOutDir);
	
			const artifactLibDir = join(artifactOutDir, 'onnxruntime', 'lib');
			await Deno.mkdir(artifactLibDir, { recursive: true });

			await Deno.copyFile(join(buildRoot, 'libonnxruntime_webassembly.a'), join(artifactLibDir, 'libonnxruntime.a'));

			return;
		}

		const compilerFlags = [];
		const args = [];
		if (options.cuda) {
			args.push('-Donnxruntime_USE_CUDA=ON');
			// https://github.com/microsoft/onnxruntime/pull/20768
			args.push('-Donnxruntime_NVCC_THREADS=1');
			if (options.trt) {
				args.push('-Donnxruntime_USE_TENSORRT=ON');
				args.push('-Donnxruntime_USE_TENSORRT_BUILTIN_PARSER=ON');
			}

			switch (platform) {
				case 'linux': {
					const cudnnArchiveStream = await fetch(Deno.env.get('CUDNN_URL')!).then(c => c.body!);
					const cudnnOutPath = join(root, 'cudnn');
					await Deno.mkdir(cudnnOutPath);
					await $`tar xvJC ${cudnnOutPath} --strip-components=1 -f -`.stdin(cudnnArchiveStream);
					args.push(`-Donnxruntime_CUDNN_HOME=${cudnnOutPath}`);
					
					if (options.trt) {
						const trtArchiveStream = await fetch(Deno.env.get('TENSORRT_URL')!).then(c => c.body!);
						const trtOutPath = join(root, 'tensorrt');
						await Deno.mkdir(trtOutPath);
						await $`tar xvzC ${trtOutPath} --strip-components=1 -f -`.stdin(trtArchiveStream);
						args.push(`-Donnxruntime_TENSORRT_HOME=${trtOutPath}`);
					}

					break;
				}
				case 'win32': {
					// nvcc < 12.4 throws an error with VS 17.10
					args.push('-DCMAKE_CUDA_FLAGS_INIT=-allow-unsupported-compiler');

					// windows should ship with bsdtar which supports extracting .zips
					const cudnnArchiveStream = await fetch(Deno.env.get('CUDNN_URL')!).then(c => c.body!);
					const cudnnOutPath = join(root, 'cudnn');
					await Deno.mkdir(cudnnOutPath);
					await $`tar xvC ${cudnnOutPath} --strip-components=1 -f -`.stdin(cudnnArchiveStream);
					args.push(`-Donnxruntime_CUDNN_HOME=${cudnnOutPath}`);
					
					if (options.trt) {
						const trtArchiveStream = await fetch(Deno.env.get('TENSORRT_URL')!).then(c => c.body!);
						const trtOutPath = join(root, 'tensorrt');
						await Deno.mkdir(trtOutPath);
						await $`tar xvC ${trtOutPath} --strip-components=1 -f -`.stdin(trtArchiveStream);
						args.push(`-Donnxruntime_TENSORRT_HOME=${trtOutPath}`);
					}

					break;
				}
			}
		}

		if (platform === 'win32' && options.directml) {
			args.push('-Donnxruntime_USE_DML=ON');
		}
		if (platform === 'darwin' && options.coreml) {
			args.push('-Donnxruntime_USE_COREML=ON');
		}
		if (platform === 'linux' && options.rocm) {
			args.push('-Donnxruntime_USE_ROCM=ON');
			args.push('-Donnxruntime_ROCM_HOME=/opt/rocm');
		}
		if (options.xnnpack) {
			args.push('-Donnxruntime_USE_XNNPACK=ON');
		}
		if (options.webgpu) {
			args.push('-Donnxruntime_USE_WEBGPU=ON');
		}

		if (!options.wasm) {
			if (platform === 'darwin') {
				if (options.arch === 'aarch64') {
					args.push('-DCMAKE_OSX_ARCHITECTURES=arm64');
				} else {
					args.push('-DCMAKE_OSX_ARCHITECTURES=x86_64');
				}
			} else {
				if (options.arch === 'aarch64' && arch !== 'arm64') {
					args.push('-Donnxruntime_CROSS_COMPILING=ON');
					switch (platform) {
						case 'win32':
							args.push('-A', 'ARM64');
							compilerFlags.push('_SILENCE_ALL_CXX23_DEPRECATION_WARNINGS');
							break;
						case 'linux':
							args.push(`-DCMAKE_TOOLCHAIN_FILE=${join(root, 'toolchains', 'aarch64-unknown-linux-gnu.cmake')}`);
							break;
					}
				}
			}
		}

		if (options.training) {
			args.push('-Donnxruntime_ENABLE_TRAINING=ON');
			args.push('-Donnxruntime_ENABLE_LAZY_TENSOR=OFF');
		}

		if (options.training || options.rocm) {
			args.push('-Donnxruntime_DISABLE_RTTI=OFF');
		}

		// Already defined below.
		// if (platform === 'win32' && !options.static) {
		// 	args.push('-DONNX_USE_MSVC_STATIC_RUNTIME=OFF');
		// 	args.push('-Dprotobuf_MSVC_STATIC_RUNTIME=OFF');
		// 	args.push('-Dgtest_force_shared_crt=OFF');
		// }

		// if (!options.static) {
		// 	// actually, with CUDA & TensorRT, we could statically link the onnxruntime core (just not the EPs)
		// 	// ... could be the move (just needs the below fix for windows)
		// 	// 	if (platform === 'win32') {
		// 	// 		args.push('-DONNX_USE_MSVC_STATIC_RUNTIME=OFF');
		// 	// 		args.push('-Dprotobuf_MSVC_STATIC_RUNTIME=OFF');
		// 	// 		args.push('-Dgtest_force_shared_crt=ON');
		// 	// 	}
		// 	args.push('-Donnxruntime_BUILD_SHARED_LIB=ON');
		// } else {
		// 	if (platform === 'win32') {
		// 		args.push('-DONNX_USE_MSVC_STATIC_RUNTIME=ON');
		// 		args.push('-Dprotobuf_MSVC_STATIC_RUNTIME=ON');
		// 		args.push('-Dgtest_force_shared_crt=OFF');
		// 		args.push('-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded');
		// 	}
		// }

		if (options.static) {
			if (platform === 'win32') {
				args.push('-DONNX_USE_MSVC_STATIC_RUNTIME=ON');
				args.push('-Dprotobuf_MSVC_STATIC_RUNTIME=ON');
				args.push('-Dgtest_force_shared_crt=OFF');
				args.push('-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded');
				args.push('-DABSL_MSVC_STATIC_RUNTIME=ON');
			}
		}

		// https://github.com/microsoft/onnxruntime/pull/21005
		if (platform === 'win32') {
			compilerFlags.push('_DISABLE_CONSTEXPR_MUTEX_CONSTRUCTOR');
		}

		args.push('-Donnxruntime_BUILD_UNIT_TESTS=OFF');

		if (compilerFlags.length > 0) {
			const allFlags = compilerFlags.map(def => `-D${def}`).join(' ');
			args.push(`-DCMAKE_C_FLAGS=${allFlags}`);
			args.push(`-DCMAKE_CXX_FLAGS=${allFlags}`);
		}

		const sourceDir = options.static ? join(root, 'src', 'static-build') : 'cmake';
		const outDir = join(root, 'output');

		await $`cmake -S ${sourceDir} -B build -D CMAKE_BUILD_TYPE=Release -DCMAKE_CONFIGURATION_TYPES=Release -DCMAKE_INSTALL_PREFIX=${outDir} -DONNXRUNTIME_SOURCE_DIR=${onnxruntimeRoot} --compile-no-warning-as-error ${args}`;
		await $`cmake --build build --config Release --parallel ${cpus().length}`;
		await $`cmake --install build --config Release`;

		const artifactOutDir = join(root, 'artifact');
		await Deno.mkdir(artifactOutDir);

		const artifactLibDir = join(artifactOutDir, 'onnxruntime', 'lib');
		await Deno.mkdir(artifactLibDir, { recursive: true });
		const srcLibsDir = join(outDir, 'lib');

		const staticLibName = (name: string) =>
			`${platform !== 'win32' ? 'lib' : ''}${name}${platform !== 'win32' ? '.a' : '.lib'}`;
		const dynamicLibName = (name: string) =>
			`${platform !== 'win32' ? 'lib' : ''}${name}${platform === 'win32' ? '.dll' : platform === 'darwin' ? '.dylib' : '.so'}`;
		const copyLib = async (filename: string) =>
			await Deno.copyFile(join(srcLibsDir, filename), join(artifactLibDir, filename));

		if (options.static) {
			await copyLib(staticLibName('onnxruntime'));
		} else {
			if (platform !== 'win32') {
				await copyLib(dynamicLibName('onnxruntime'));
			} else {
				await copyLib(staticLibName('onnxruntime'));
				// on windows, onnxruntime.dll is in /bin/, for whatever reason
				await Deno.copyFile(join(outDir, 'bin', 'onnxruntime.dll'), join(artifactLibDir, 'onnxruntime.dll'));
			}

			if (options.cuda || options.trt || options.rocm) {
				if (platform !== 'win32') {
					await copyLib(dynamicLibName('onnxruntime_providers_shared'));
				} else {
					await copyLib(staticLibName('onnxruntime_providers_shared'));
					// ditto 🙃
					await Deno.copyFile(
						join(outDir, 'bin', 'onnxruntime_providers_shared.dll'),
						join(artifactLibDir, 'onnxruntime_providers_shared.dll')
					);
				}
			}

			if (options.cuda) {
				await copyLib(dynamicLibName('onnxruntime_providers_cuda'));
			}
			if (options.trt) {
				await copyLib(dynamicLibName('onnxruntime_providers_tensorrt'));
			}
			if (options.rocm) {
				await copyLib(dynamicLibName('onnxruntime_providers_rocm'));
			}
		}
	})
	.parse(Deno.args);
