const { Terminal } = require('xterm-headless');
const { SerializeAddon } = require("xterm-addon-serialize");

const fastq = require('fastq')
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty-prebuilt-multiarch-cp');
const path = require("path")
const sudo = require('sudo-prompt');
const unparse = require('yargs-unparser-custom-flag');
const shellPath = require('shell-path');
const home = os.homedir()
class Shell {
  /*
    params 
    req := {
      uri: <root uri>,
      method,
      params: {
        id,
        path,
        env
      }
    }
  */
  constructor(kernel) {
    this.kernel = kernel
    this.platform = os.platform()
    this.shell = this.platform === 'win32' ? 'cmd.exe' : 'bash';
    //this.vt = new Terminal({ allowProposedApi: true, scrollback: 5, })
    // this.vt = new Terminal({
    //     allowProposedApi: true,
    //     cols: 200,
    //     rows: 30,

    // })
    // this.vts = new SerializeAddon()
    // this.vt.loadAddon(this.vts)
    this.checkpoint = {
      on: [],
      sequence: [],
      serialized: 0
    }
    this.queue = fastq((data, cb) => {
      this.stream(data, cb)
//      cb()
    }, 1)

  }
  async start(params, ondata) {

    /*
      params := {
        group: <group id>,
        id: <shell id>,
        path: <shell cwd (always absolute path)>,
        env: <environment value key pairs>
      }
    */
    this.cols = params.cols ? params.cols : 100;
    this.rows = params.rows ? params.rows : 30;

    this.vt = new Terminal({
      allowProposedApi: true,
      cols: this.cols,
      rows: this.rows,
    })
    this.vts = new SerializeAddon()
    this.vt.loadAddon(this.vts)

    // 1. id
    this.id = (params.id ? params.id : uuidv4())

    // 2. group id
    this.group = params.group

    // 2. env
    // default env
    this.env = Object.assign({}, process.env)
    // If the user has set PYTHONPATH, unset it.
    if (this.env.PYTHONPATH) {
      delete this.env.PYTHONPATH
    }

    // Well Known Cache
    this.env.HF_HOME = path.resolve(this.kernel.homedir, "cache", "HF_HOME")
    this.env.TORCH_HOME = path.resolve(this.kernel.homedir, "cache", "TORCH_HOME")
    this.env.HOMEBREW_CACHE = path.resolve(this.kernel.homedir, "cache", "TORCH_HOME")
    this.env.XDG_CACHE_HOME = path.resolve(this.kernel.homedir, "cache", "XDG_CACHE_HOME")

    let PATH_KEY;
    if (this.env.Path) {
      PATH_KEY = "Path"
    } else if (this.env.PATH) {
      PATH_KEY = "PATH"
    }
    if (this.platform === 'win32') {
      // ignore 
    } else {
      this.env[PATH_KEY]= shellPath.sync() || [
        './node_modules/.bin',
        '/.nodebrew/current/bin',
        '/usr/local/bin',
        this.env[PATH_KEY]
      ].join(':');
    }
    // custom env was passed in
    if (params.env) {
      for(let key in params.env) {
        // iterate through the env attributes
        let val = params.env[key]
        if (key.toLowerCase() === "path") {
          // "path" is a special case => merge with process.env.PATH
          if (params.env.path) {
            this.env[PATH_KEY] = `${params.env.path.join(path.delimiter)}${path.delimiter}${this.env[PATH_KEY]}`
          }
          if (params.env.PATH) {
            this.env[PATH_KEY] = `${params.env.PATH.join(path.delimiter)}${path.delimiter}${this.env[PATH_KEY]}`
          }
          if (params.env.Path) {
            this.env[PATH_KEY] = `${params.env.Path.join(path.delimiter)}${path.delimiter}${this.env[PATH_KEY]}`
          }
        } else if (Array.isArray(val)) {
          if (this.env[key]) {
            this.env[key] = `${val.join(path.delimiter)}${path.delimiter}${this.env[key]}`
          } else {
            this.env[key] = `${val.join(path.delimiter)}`
          }
        } else {
          // for the rest of attributes, simply set the values
          this.env[key] = params.env[key]
        }
      }
    }

    for(let key in this.env) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        delete this.env[key]
      }
      if (/[\r\n]/.test(this.env[key])) {
        delete this.env[key]
      }
    }

    // 3. path => path can be http, relative, absolute
    this.path = params.path

    // automatically add self to the shells registry
    this.kernel.shell.add(this)

    if (params.sudo) {
      let options = {
        name: "Pinokio",
        env: {}
//        icns: '/Applications/Electron.app/Contents/Resources/Electron.icns', // (optional)
      };
      for(let key in this.env) {
        options.env[key] = String(this.env[key])
      }
      let response = await new Promise((resolve, reject) => {
        params.message = this.build({ message: params.message })
        if (ondata) ondata({ id: this.id, raw: params.message + "\r\n" })
        sudo.exec(params.message, options, (err, stdout, stderr) => {
          if (err) {
            reject(err)
          } else if (stderr) {
            reject(stderr)
          } else {
            resolve(stdout)
          }
        });
      })
      if (ondata) ondata({
        id: this.id,
        raw: response.replaceAll("\n", "\r\n")
      })
      return response
    } else {
      let response = await this.request(params, async (stream) => {
        if (stream.prompt) {
          this.resolve()
        } else {
          if (ondata) ondata(stream)
        }
      })
      return response
    }

//    return this.id
  }
  emit(message) {
    if (this.ptyProcess) {
      this.ptyProcess.write(message)
    }
  }
  send(message, newline, cb) {
    if (this.ptyProcess) {
      this.cb = cb
      return new Promise((resolve, reject) => {
        this.resolve = resolve
        this.cmd = this.build({ message })
        this.ptyProcess.write(this.cmd)
        if (newline) {
          this.ptyProcess.write(os.EOL)
        }
      })
    }
  }
  enter(message, cb) {
    if (this.ptyProcess) {
      this.cb = cb
      return new Promise((resolve, reject) => {
        this.resolve = resolve
        this.cmd = this.build({ message })
        this.ptyProcess.write(this.cmd)
        this.ptyProcess.write(os.EOL)
      })
    }
  }
  write(message, cb) {
    if (this.ptyProcess) {
      this.cb = cb
      return new Promise((resolve, reject) => {
        this.resolve = resolve
        this.cmd = this.build({ message })
        this.ptyProcess.write(this.cmd)
      })
    }
  }
  clear() {
    if (this.platform === 'win32') {
      // For Windows
      this.vt.write('\x1Bc');
      //this.ptyProcess.write('cls\n');
    } else {
      // For Unix-like systems (Linux, macOS)
      this.vt.write('\x1B[2J\x1B[3J\x1B[H');
      //this.ptyProcess.write('clear\n')
    }
  }
  async run(params, cb) {
    let r = await this.request(params, cb)
    return r
  }
  async request(params, cb) {

    // create the path if it doesn't exist
    await fs.promises.mkdir(params.path, { recursive: true }).catch((e) => { })

    // not connected => make a new connection => which means get a new prompt
    // if already connected => no need for a new prompt
    if (params.persistent) {
      this.persistent = params.persistent
    }
    this.prompt_pattern = await this.prompt(params.path)
    this.cb = cb
    let r = await this.exec(params)
    return r
  }
  respond(data) {
    this.clear()
    this.resolve(data)
    this.cb  = undefined // clean up cb so that it doesn't get triggered anymore
    this.resolve = undefined
  }
  // get the prompt => used to detec when the process ends (even when there is no clean exit)
  prompt(cwd) {
    return new Promise((resolve, reject) => {
      const config = {
        name: 'xterm-color',
        cols: this.cols,
        rows: this.rows,
        //cols: 1000,
        //rows: 30,
      }
      if (cwd) {
        config.cwd = path.resolve(cwd)
      }
      config.env = this.env
      //let re = /(.+\r\n)(\1)/gs

      //let re = /([\r\n]+[^\r\n]+)(\1)/gs
      let re = /(.+)(\1)/gs
      let term = pty.spawn(this.shell, [], config)
      let ready
      let vt = new Terminal({
        allowProposedApi: true
      })
      let vts = new SerializeAddon()
      vt.loadAddon(vts)

      let queue = fastq((data, cb) => {
        vt.write(data, () => {
          let buf = vts.serialize()
          buf = buf.replaceAll(/[\r\n]/g, '')
          let test = re.exec(buf)
          if (test && test.length >= 2) {
            const escaped = this.stripAnsi(test[1])
              .replaceAll(/[\r\n]/g, "")
              .trim()
              .replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
            term.kill()
            vt.dispose()
            resolve(escaped)
            queue.killAndDrain()
          }
        })
        cb()
      }, 1)
      term.onData((data) => {
        if (ready) {
          queue.push(data)
        } else {
          setTimeout(() => {
            if (!ready) {
              ready = true
              term.write(`${os.EOL}${os.EOL}`)
            }
          }, 500)
        }
      });
    })
  }
  stripAnsi (str) {
    const pattern = [
      '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
      '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-Za-z=><~]))'
    ].join('|');
    const regex = new RegExp(pattern, 'gi')
    return str.replaceAll(regex, '');
  }
  exists(abspath) {
    return new Promise(r=>fs.access(abspath, fs.constants.F_OK, e => r(!e)))
  }
  build (params) {

    if (params.message) {
      if (typeof params.message === "string") {
        // raw string -> do not touch
        return params.message
      } else if (Array.isArray(params.message)) {
        // if params.message is empty, filter out
        let delimiter = " && "
        return params.message.filter((m) => {
          return m && !/^\s+$/.test(m)
        }).join(delimiter)
        //return params.message.join(" && ")
      } else {
        // command line message
        let chunks = unparse(params.message).map((item) => {
          let tokens = item.split(" ")
          if (tokens.length > 1) {
            return `"${item}"`
          } else {
            return item
          }
        })
        return `${chunks.join(" ")}`
      }
    } else {
      return ""
    }
  }
  async activate(params) {
    if (params.conda) {
      if (params.conda === "base") {
        // using the base env
        params.message = [
          (this.platform === 'win32' ? 'conda_hook' : `eval "$(conda shell.bash hook)"`),
          `conda activate ${params.conda}`,
        ].concat(params.message)
      } else {
        let env_path = path.resolve(params.path, params.conda)
        let env_exists = await this.exists(env_path)
        if (env_exists) {
          params.message = [
            (this.platform === 'win32' ? 'conda_hook' : `eval "$(conda shell.bash hook)"`),
            //`conda activate ${params.conda}`,
            `conda activate ${env_path}`,
          ].concat(params.message)
        } else {
          params.message = [
            (this.platform === 'win32' ? 'conda_hook' : `eval "$(conda shell.bash hook)"`),
            `conda create -y -p ${env_path}`,
            //`conda activate ${params.conda}`,
            `conda activate ${env_path}`,
          ].concat(params.message)
        }
      }
    } else if (params.venv) {
      let env_path = path.resolve(params.path, params.venv)
      let activate_path = (this.platform === 'win32' ? path.resolve(env_path, "Scripts", "activate") : path.resolve(env_path, "bin", "activate"))
      let env_exists = await this.exists(env_path)
      if (env_exists) {
        params.message = [
          (this.platform === "win32" ? `${activate_path} ${env_path}` : `source ${activate_path} ${env_path}`),
        ].concat(params.message)
      } else {
        params.message = [
          `python -m venv ${env_path}`,
          (this.platform === "win32" ? `${activate_path} ${env_path}` : `source ${activate_path} ${env_path}`),
        ].concat(params.message)
      }
    }

//    May need to run conda_hook for all shells?
//    } else {
//      // if no conda and no venv
//      // using the base conda env
//      let e = await this.exists(this.kernel.bin.path("miniconda"))
//      if (e) {
//        params.message = [
//          (this.platform === 'win32' ? 'conda_hook' : `eval "$(conda shell.bash hook)"`),
//          `conda activate base`,
//        ].concat(params.message)
//      }
//    }
    return params
  }
  async exec(params) {
    params = await this.activate(params)
    this.cmd = this.build(params)
    let res = await new Promise((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
      try {
        const config = {
          name: 'xterm-color',
          //cols: 1000,
          //rows: 30,
          cols: this.cols,
          rows: this.rows,
  
        }
        if (params.path) {
          config.cwd = path.resolve(params.path)
        }

        config.env = this.env
        if (!this.ptyProcess) {
          // ptyProcess doesn't exist => create
          this.done = false
          this.ptyProcess = pty.spawn(this.shell, [], config)
          this.ptyProcess.onData((data) => {
            if (!this.done) {
              this.queue.push(data)
            }
          });
        }
      } catch (e) {
        this.kill()
      }
    })
    return res
  }
  stop(message) {
    return this.kill(message)
  }
  continue(message) {
    if (this.resolve) {
      if (message) {
        this.resolve(message)
      } else {
        let buf = this.stripAnsi(this.vts.serialize())
        this.resolve(buf)
      }
      this.resolve = undefined
    }
  }
  kill(message, force) {
    this.done = true
    this.ready = false
    if (this.resolve) {
      if (message) {
        this.resolve(message)
      } else {
        let buf = this.stripAnsi(this.vts.serialize())
        this.resolve(buf)
      }
      this.resolve = undefined
    }
    this.vt.dispose()
    this.queue.killAndDrain()
    if (this.ptyProcess) {
      this.ptyProcess.kill()
      this.ptyProcess = undefined
    }

    // automatically remove the shell from this.kernel.shells
    this.kernel.shell.rm(this.id)

  }
  stream(msg, callback) {
    this.vt.write(msg, () => {
      let buf = this.vts.serialize()
      let cleaned = this.stripAnsi(buf)
      let response = {
        id: this.id,
        raw: msg,
        cleaned,
        state: cleaned
      }
      if (this.cb) this.cb(response)

      // Decide whether to kill or continue
      if (this.ready) {
        // when ready, watch out for the prompt pattern that terminates with [\r\n ]
        let termination_prompt_re = new RegExp(this.prompt_pattern + "[ \r\n]*$", "g")
        let line = cleaned.replaceAll(/[\r\n]/g, "")
        let test = line.match(termination_prompt_re)
        if (test) {
          let cache = cleaned
          let cached_msg = msg
          // todo: may need to handle cases when the command returns immediately with no output (example: 'which brew' returns immediately with no text if brew doesn't exist)
          setTimeout(() => {
            if (cache === cleaned) {
              if (this.persistent) {
                if (this.cb) this.cb({
                  //raw: cached_msg,
                  //raw: msg,
                  //raw: "",
                  cleaned,
                  state: cleaned,
                  prompt: true
                })
                callback()
              } else {
                callback()
                this.kill()
              }
            } else {
              //console.log("## more incoming... ignore")
            }
          }, 500)
        } else {
          callback()
        }
      } else {
        callback()
        // when not ready, wait for the first occurence of the prompt pattern.
        let prompt_re = new RegExp(this.prompt_pattern, "g")
        let test = cleaned.replaceAll(/[\r\n]/g, "").match(prompt_re)
        if (test) {
          if (test.length > 0) {
            this.ready = true
            if (this.ptyProcess) {
              this.ptyProcess.write(`${this.cmd}${os.EOL}`)
            }
          }
        }
        //callback()
      }
    })
  }
  regex (str) {
    let matches = /^\/([^\/]+)\/([dgimsuy]*)$/.exec(str)
    if (!/g/.test(matches[2])) {
      matches[2] += "g"   // if g option is not included, include it (need it for matchAll)
    }
    return new RegExp(matches[1], matches[2])
  }
}
module.exports = Shell
