//
// Grunt Task File
// ---------------
//
// Task: FTP Deploy
// Description: Deploy code over FTP
// Dependencies: jsftp
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

  var toTransfer;
  var sftpConn;
  var sshConn;
  var localRoot;
  var remoteRoot;
  var currPath;
  var authVals;
  var exclusions;

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
      if (!file.isMatch(exclusions, currFile)) {
        if (file.isDir(currFile)) {
          tmpPath = path.relative(localRoot, startDir + path.sep + files[i]);
          if (!_.has(result, tmpPath)) {
            result[tmpPath] = [];
          }
          dirParseSync(startDir + path.sep + files[i], result);
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
    if (inFilename == '.gitignore') {
      cb(null);
      return true;
    }

    var fromFile = localRoot + path.sep + inFilename;
    var toFile = remoteRoot + path.sep + inFilename;
    // console.log(fromFile + ' to ' + toFile);
    process.stdout.write(fromFile + ' to ' + toFile);

    var from = fs.createReadStream(fromFile);
    var to = sftpConn.createWriteStream(toFile, {
      flags: 'w',
      mode: 0755
    });
    // var to = process.stdout;

    from.on('data', function(){
      // console.log('fs.data ', inFilename);
      process.stdout.write('.');
    });

    from.on('close', function(){
      // console.log('fs.close from', inFilename);
      // sftpConn.end();
    });

    to.on('close', function(){
      // console.log('sftp.close to', inFilename);
      process.stdout.write('done.'+"\n");
      // sftpConn.end();
      cb(null);
    });

    from.pipe(to);
  }

  // A method that processes a location - changes to a folder and uploads all respective files
  function sftpProcessLocation (inPath, cb) {
    if (!toTransfer[inPath]) {
      cb(new Error('Data for ' + inPath + ' not found'));
    }
    var files;

    currPath = inPath;
    files = toTransfer[inPath];
    remotePath = remoteRoot + inPath;

    sftpConn.mkdir(remotePath, {permissions: 0775}, function(err) {
      console.log('mkdir ' + remotePath, err ? 'error or dir exists' : 'ok');

      // console.log(async);
      async.forEachLimit(files, 1, sftpPut, function (err) {
        // console.log('callback');
        cb(null);
      });
    });
  }

  function getAuthByKey (inKey) {
    var tmpStr;
    var retVal = null;

    if (fs.existsSync('.ftppass')) {
      tmpStr = grunt.file.read('.ftppass');
      if (inKey != null && tmpStr.length) retVal = JSON.parse(tmpStr)[inKey];
    }
    return retVal;
  }

  // The main grunt task
  grunt.registerMultiTask('ftp-deploy', 'Deploy code over FTP', function() {
    var done = this.async();

    // Init
    sshConn = new SSHConnection();

    localRoot = Array.isArray(this.data.src) ? this.data.src[0] : this.data.src;
    remoteRoot = Array.isArray(this.data.dest) ? this.data.dest[0] : this.data.dest;
    authVals = getAuthByKey(this.data.auth.authKey);
    exclusions = this.data.exclusions || [];
    toTransfer = dirParseSync(localRoot);
    // console.log('localRoot', localRoot);
    // console.log('remoteRoot', remoteRoot);
    // console.log('toTransfer', toTransfer);

    // Checking if we have all the necessary credentilas before we proceed
    if (authVals == null || authVals.username == null || authVals.password == null) {
      grunt.warn('Username or Password not found!');
    }
    log.ok('log in as ' + authVals.username);

    sshConn.connect({
      host: this.data.auth.host,
      port: this.data.auth.port,
      username: authVals.username,
      password: authVals.password
    });

    sshConn.on('connect', function () {
      console.log('Connection :: connect');
    });
    sshConn.on('error', function (err) {
      console.log('Connection :: error ::', err);
    });
    sshConn.on('end', function () {
      console.log('Connection :: end');
    });
    sshConn.on('close', function (had_error) {
      console.log('Connection :: close', had_error);
    });

    sshConn.on('ready', function () {
      console.log('Connection :: ready');

      sshConn.sftp(function (err, sftp) {
        if (err) throw err;

        sftpConn = sftp;

        sftp.on('end', function () {
          console.log('SFTP :: SFTP session closed');
          console.trace();
        });
        sftp.on('close', function () {
          console.log('SFTP :: close');
          // console.trace();
          sshConn.end();
        });
        sftp.on('error', function (e) {
          console.log('SFTP :: error', e);
          sshConn.end();
        });
        sftp.on('open', function (e) {
          console.log('SFTP :: open');
        });

        var locations = _.keys(toTransfer);
        console.dir(locations);

        // Iterating through all location from the `localRoot` in parallel
        async.forEachSeries(locations, sftpProcessLocation, function() {
          log.ok('uploads done');
          sftp.end();
        });

      });
    });

    // sshConn.end();

    if (grunt.errors) {
      return false;
    }
  });
};
