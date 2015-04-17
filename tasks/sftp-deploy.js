//
// Grunt Task File
// ---------------
//
// Task: SFTP Deploy
// Description: Deploy code over SFTP
// Dependencies: ssh2
//

module.exports = function(grunt) {

  grunt.util = grunt.util || grunt.utils;

  var async = grunt.util.async;
  var log = grunt.log;
  var _ = grunt.util._;
  var file = grunt.file;
  var fs = require('fs');
  var path = require('path');
  var util = require('util');
  var SSHConnection = require('ssh2');
  var progress = require('progress');

  var toTransfer;
  var sftpConn;
  var sshConn;
  var localRoot;
  var remoteRoot;
  var remoteSep;
  var authVals;
  var exclusions;
  var progressLogger;
  var transferred = 0;
  var with_progress = true;

  var cache;
  var cacheEnabled;
  var cacheFileName;

  // A method for parsing the source location and storing the information into a suitably formated object
  function dirParseSync(startDir, result) {
    var files;
    var i;
    var tmpPath;
    var currFile;

    // initialize the `result` object if it is the first iteration
    if (result === undefined) {
      result = {};
      result[path.sep] = [];
    }

    // check if `startDir` is a valid location
    if (!fs.existsSync(startDir)) {
      grunt.warn(startDir + ' is not an existing location');
    }

    // iterate throught the contents of the `startDir` location of the current iteration
    files = fs.readdirSync(startDir);
    for (i = 0; i < files.length; i++) {
      currFile = startDir + path.sep + files[i];
      if (!file.isMatch({matchBase: true}, exclusions, currFile)) {
        if (file.isDir(currFile)) {
          tmpPath = path.relative(localRoot, startDir + path.sep + files[i]);
          if (!_.has(result, tmpPath)) {
            result[tmpPath] = [];
          }
          dirParseSync(currFile, result);
        } else {
          tmpPath = path.relative(localRoot, startDir);
          if (!tmpPath.length) {
            tmpPath = path.sep;
          }
          result[tmpPath].push(files[i]);
        }
      }
    }

    return result;
  }

  // A method for uploading a single file
  function sftpPut(inFilename, cb) {
    var fromFile, toFile, from, to;

    fromFile = localRoot + path.sep + inFilename;
    toFile = remoteRoot + remoteSep + inFilename.split(path.sep).join(remoteSep);

    if(path.sep != remoteSep) {
      toFile = toFile.replace(new RegExp(path.sep == '\\' ? '\\\\' : '\\/', 'g'), remoteSep);
    }

    grunt.verbose.write(fromFile + ' to ' + toFile);

    var f_size = fs.statSync(fromFile).size;

    var upload = function(fromFile, toFile, cb) {
      sftpConn.fastPut( fromFile, toFile, function(err){
        if (err){
          log.write((' Error uploading file: ' + err.message).red + '\n');
          cb(err);
        } else {
          grunt.verbose.write(' done'.green + '\n' );
          if( with_progress ) progressLogger.tick();
          transferred += parseInt(f_size/1024);
          cb(null);
        }
      });
    };

    if (cacheEnabled) {
      fs.stat(fromFile, function(err, fromFileData){
        if (cache[fromFile] && +new Date(cache[fromFile]) >= +new Date(fromFileData.mtime)) {
          cb(null);
        } else {
          cache[fromFile] = fromFileData.mtime;
          upload(fromFile, toFile, cb);
        }
      } );
    } else {
      upload(fromFile, toFile, cb);
    }

  }

  // A method that processes a location - changes to a folder and uploads all respective files
  function sftpProcessDirectories (inPath, cb) {
    if (!toTransfer[inPath]) {
      cb(new Error('Data for ' + inPath + ' not found'));
    }
    var remoteInPath;

    if(inPath.indexOf(path.sep) !== -1){
      remoteInPath = inPath.split(path.sep).join(remoteSep);
    }else{
      remoteInPath = inPath;
    }

    var remotePath = remoteRoot + (remoteInPath == remoteSep ?
      remoteInPath :
      remoteSep + remoteInPath);

    sftpConn.mkdir(remotePath, {mode: 0755}, function(err) {
      grunt.verbose.writeln('mkdir ' + remotePath, err ? 'error or dir exists' : 'ok');
      if( with_progress ) progressLogger.tick();
      cb(null);
    });
  }

  function getAuthByKey(inKey) {
    if (inKey !== null) {

      if (typeof inKey == 'object') {
        return inKey;

      } else if (process.env[inKey]) {
        return JSON.parse(process.env[inKey]);

      } else if (fs.existsSync(inKey)) {
        return JSON.parse(grunt.file.read(inKey)) || null;

      } else if (fs.existsSync('.ftppass')) {
        return JSON.parse(grunt.file.read('.ftppass'))[inKey] || null;
      }

    } else return null;
  }

  function getKeyLocation(customKey) {
    var keyLocation = null;
    var defaultKeys = [
      process.env.HOME + '/.ssh/id_dsa',
      process.env.HOME + '/.ssh/id_rsa'
    ];

    if (customKey) {
      if (fs.existsSync(customKey)) {
        keyLocation = customKey;
      } else if (fs.existsSync(path.join(process.env.HOME, '.ssh', customKey))) {
        keyLocation = path.join(process.env.HOME, '.ssh', customKey);
      }
    } else {
      for (var i = 0; i < defaultKeys.length; i++) {
        if (fs.existsSync(defaultKeys[i])) keyLocation = defaultKeys[i];
      }
    }

    if (keyLocation === null) grunt.warn('Could not find private key.');
    return keyLocation;
  }

  function getLength(toTransfer){
    var i = 0;
    for(var n in toTransfer ){
      if(!toTransfer[n].substr){
        i+= getLength(toTransfer[n]);
      }
      i++;
    }
    return i;
  }
  function getFiles(toTransfer){
    var ret = [];
    for(var n in toTransfer ){
      for( var k in toTransfer[n]){
        ret.push( (n==path.sep?"":n+path.sep)+toTransfer[n][k]);
      }
    }
    return ret;
  }


  // The main grunt task
  grunt.registerMultiTask('sftp-deploy', 'Deploy code over SFTP', function() {
    var done = this.async();
    var keyLocation,connection,agentSocket;

    cacheEnabled = !!this.data.cache;
    cacheFileName = this.data.cache;

    if (cacheEnabled) {
      if (fs.existsSync(cacheFileName)) {
        try{
          cache = JSON.parse(fs.readFileSync(cacheFileName) || {});
        } catch(e) {
          cache = {};
        }
      } else {
        fs.writeFileSync(cacheFileName, '{}');
        cache = {};
      }
    }

    // Init
    sshConn = new SSHConnection();

    transferred = 0;
    localRoot = Array.isArray(this.data.src) ? this.data.src[0] : this.data.src;
    remoteRoot = Array.isArray(this.data.dest) ? this.data.dest[0] : this.data.dest;
    remoteSep = this.data.serverSep ? this.data.serverSep : "/";
    var concurrency = parseInt(this.data.concurrency) || 4;
    with_progress = this.data.progress || !grunt.option("verbose");

    authVals = getAuthByKey(this.data.auth.authKey);
    exclusions = this.data.exclusions || [];

    toTransfer = dirParseSync(localRoot);
    progressLogger = new progress('  transferred=[:current/:total] elapsed=[:elapseds] overall=[:percent] eta=[:etas] [:bar]', {
      complete: '=',
      incomplete: ' ',
      width: 40,
      total: getLength(toTransfer)
    });

    connection = {
      host: this.data.auth.host,
      port: this.data.auth.port
    };

    // Use either password or key-based login
    if (typeof authVals === 'undefined' || authVals === null) {
      grunt.warn('.ftppass seems to be missing or incomplete');
    } else {
      connection.username = authVals.username;
      if (authVals.agent === true) {
        agentSocket = process.env.SSH_AUTH_SOCK;
        if (agentSocket === undefined) {
          log.warn('Could not get the ssh-agent socket. Is the SSH_AUTH_SOCK enviroment variable set?');
        } else {
          connection.agent = agentSocket;
          log.ok('Logging in with ssh-agent-based authentication');
        }
      } else if (typeof authVals.agent === 'string') {
        connection.agent = authVals.agent;
        log.ok('Logging in with SSH agent "' + connection.agent + '"');
      } else if (authVals.password === undefined) {
        keyLocation = getKeyLocation(authVals.keyLocation);
        connection.privateKey = fs.readFileSync(keyLocation);
        if (authVals.passphrase) connection.passphrase = authVals.passphrase;
        log.ok('Logging in with key at ' + keyLocation);
      } else {
        connection.password = authVals.password;
        log.ok('Logging in with username ' + authVals.username);
      }
    }

    var has_transferred_all_files = false;
    var already_done = false;
    var done_handler = function(err){
      if( already_done ) return;
      already_done = true;
      sshConn.end();
      if (cacheEnabled) {
        fs.writeFileSync(cacheFileName, JSON.stringify(cache) || {});
      }
      grunt.log.ok("Transferred : "+(transferred/1024)+" Mb" );
      if(!has_transferred_all_files || err){
        grunt.log.writeln(err);
        grunt.fail.fatal('Transfer did not succeeded');
      }
      done();
    };

    log.ok('Concurrency : ' + concurrency);
    sshConn.connect(connection);

    sshConn.on('connect', function () {
      grunt.verbose.writeln('Connection :: connect');
    });
    sshConn.on('error', function (e) {
      grunt.log.error(e);
      grunt.fail.fatal('Connection :: error');
      done_handler();
    });
    sshConn.on('end', function (e) {
      grunt.verbose.writeln('Connection :: end', e);
      done_handler();
    });
    sshConn.on('close', function (e) {
      grunt.verbose.writeln('Connection :: close', e);
      done_handler();
    });

    sshConn.on('ready', function () {
      // console.log('Connection :: ready');

      sshConn.sftp(function (err, sftp) {
        if (err) throw err;

        sftpConn = sftp;

        sftp.on('end', function (e) {
          grunt.verbose.writeln('SFTP :: SFTP session closed',e);
          done_handler();
        });
        sftp.on('close', function (e) {
          grunt.verbose.writeln('SFTP :: close',e);
        });
        sftp.on('error', function (e) {
          grunt.log.error(e);
          grunt.fail.fatal('SFTP :: error');
          done_handler();
        });
        sftp.on('open', function () {
          grunt.verbose.writeln('SFTP :: open');
        });

        var locations = _.keys(toTransfer);
        // console.dir(locations);

        sftp.mkdir(remoteRoot, {mode: 0755}, function(err) {
          // ignore err to not block if dir already exists
          // if( err ) return done_handler(err);

          // Iterating through all location from the `localRoot` in parallel
          async.forEachSeries(locations, sftpProcessDirectories, function(err) {
            grunt.verbose.writeln(' ');
            log.ok('Directories done.');
            has_transferred_all_files = false;

            if( err ) done_handler(err);

            // Iterating through all location from the `localRoot` in parallel
            async.forEachLimit(getFiles(toTransfer), concurrency, sftpPut, function (err) {
              // console.log('callback');
              has_transferred_all_files = true;
              done_handler(err);
            });
          });
        });

      });

    });

    if (grunt.errors) {
      return false;
    }
  });
};
