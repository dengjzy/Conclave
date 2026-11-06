import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const directory = fileURLToPath(new URL('..', import.meta.url))
async function run(command, args, cwd = directory) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, stdio: 'inherit', shell: false })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)))
  })
}
await run(process.execPath, [path.join(directory, 'scripts/build.mjs')])
await run(process.execPath, [fileURLToPath(import.meta.resolve('@capacitor/cli/bin/capacitor')), 'sync', 'android'])
const java = process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java'
await run(java, ['-classpath', path.join(directory, 'android/gradle/wrapper/gradle-wrapper.jar'), 'org.gradle.wrapper.GradleWrapperMain', '--no-daemon', ':app:assembleDebug'], path.join(directory, 'android'))
console.log(`APK: ${path.join(directory, 'android/app/build/outputs/apk/debug/app-debug.apk')}`)
