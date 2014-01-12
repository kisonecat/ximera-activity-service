var async = require('async')
  , winston = require('winston')
  , findit = require("findit")
  , fs = require('fs')
  , exec = require('child_process').exec
  , util = require('util')
  , mdb = require('../mdb')
  , misc = require('../misc')
  , crypto = require('crypto')
  , path = require('path')
  , _ = require('underscore');

// Following commands will be replaced by environments so that Pandoc will receive raw blocks for them.
var replaceCommands = ['youtube', 'answer', 'choice'];

// TODO: LaTeX is not trustable; this needs to be sandboxed using a Linux container or other mechanism before accepting user-generated content.
module.exports = function compileAndStoreTexFiles(repo, gitDirPath, callback) {
    winston.info('Compiling Git Repo.');
    var locals = {newActivityIds: []};

    async.series([
        // Get list of .tex files to process
        function (callback) {
            misc.getUnhiddenFileList(gitDirPath, '.tex', function (err, filePaths) {
                if (err) {callback(err)}
                else {
                    locals.filePaths = filePaths;
                    callback();
                }
            })
        },
        // Process each .tex file.
        function (callback) {
            async.each(
                locals.filePaths,
                function (filePath, callback) {
                    var fileName = path.basename(filePath).toString();
                    var relativeFilePath = path.relative(gitDirPath, filePath);
                    var htmlFileName = fileName.substring(0, fileName.length - 4) + '.html';
                    var htmlPath = path.join(path.dirname(filePath), htmlFileName);
                    var locals2 = {skipped: false}; // Set to true if this document's compilation was skipped; won't propagate error.


                    async.series([
                        // Check if file contains \documentclass; if not, don't compile it.
                        function (callback) {
                            var shellStr = util.format("grep '\\\\documentclass' %s", filePath);
                            exec(shellStr, function (err, stdout) {
                                if (stdout.length == 0) {
                                    locals2.skipped = true;
                                    callback('Skipping file: \\documentclass not found.');
                                }
                                else {
                                    callback();
                                }
                            });
                        },
                        // Store original contents in latexSource.
                        function (callback) {
                            winston.info('Reading original latex source.');
                            fs.readFile(filePath, 'utf8', function (err, data) {
                                if (err) callback(err)
                                else {
                                    locals.latexSource = data;
                                    callback();
                                }
                            });
                        },
                        // Replace known commands with environments so that filter will see them.
                        function (callback) {
                            async.eachSeries(replaceCommands,
                                function(command, callback) {
                                    winston.info("Replacing commands in file.");
                                    // We create Regex literals and call source on them since it saves having to escape \\.
                                    var commandRegex = new RegExp('\\\\(' + command + ')' + (/((\[[^\]]*\])*({[^}]*})*)/).source, 'g');
                                    winston.info("Regex source", commandRegex.source);
                                    fs.readFile(filePath, 'utf8', function (err, data) {
                                        data = data.replace(commandRegex, '\\begin{$1}$2\\end{$1}');
                                        fs.writeFile(filePath, data, 'utf8', callback);
                                    });


//                                    var shellStr = util.format("sed -ie 's/\\\\\\(%s\\)\\(\\(\\[[^\\]]*\\]\\)*\\({[^}]*}\\)*\\)/\\\\begin{\\1}\\2\\\\end{\\1}/g'", command, filePath);
  //                                  winston.info(shellStr);
    //                                exec(shellStr, callback);
                                },
                                callback
                            );
                        },
                        // Hash file.
                        function (callback) {
                            // Note that we hash the original file, since the Pandoc filter is non-deterministic and will include unique IDs.
                            winston.info("Hashing file.");
                            fs.readFile(filePath, 'utf8', function (err, data) {
                                if (err) callback(err)
                                else {
                                    var hasher = crypto.createHash('sha1');
                                    hasher.setEncoding('hex');
                                    hasher.update(data);
                                    hasher.end()
                                    locals.hash = hasher.read();
                                    callback();
                                }
                            });
                        },
                        // Find activity entry if it exists, if not create it.
                        function (callback) {
                            winston.info("Finding activity entry.");
                            mdb.Activity.findOne({baseFileHash: locals.hash, repoId: repo._id, relativePath: relativeFilePath}, function (err, activity) {
                                if (err)  { callback(err); }
                                else {
                                    if (activity) {
                                        locals.activityExists = true;
                                        locals.activity = activity;
                                        callback();
                                    }
                                    else {
                                        locals.activityExists = false;
                                        locals.activity = new mdb.Activity({
                                            baseFileHash: locals.hash,
                                            repoId: repo._id,
                                            relativePath: relativeFilePath,
                                            latexSource: locals.latexSource
                                        });
                                        locals.activity.save(function (err) {
                                            callback(err);
                                        })
                                    }
                                }
                            });
                        },
                        // Pandoc compilation if activity not already compiled.
                        function (callback) {
                            if (!locals.activityExists) {
                                var filterPath = process.env.XIMERA_FILTER_PATH;
                                winston.info("Executing pandoc");
                                var baseDir = path.dirname(filePath);
                                var shellStr = util.format('(cd %s; pandoc --metadata=repoId:%s --metadata=hash:%s --parse-raw -f latex -t html --filter=%s --output=%s %s)', baseDir, repo._id, locals.hash, filterPath, htmlPath, filePath);
                                winston.info(shellStr);
                                exec(shellStr, function (err, stdout, stderr) {
                                    winston.info ("Stdout: %s", stdout);
                                    winston.info("Stderr: %s", stderr);
                                    callback(err);
                                });
                            }
                            else {
                                winston.info("Document exists, skipping compilation.");
                                callback();
                            }
                        },
                        // If activity doesn't exist, save compiled pandoc file
                        // and create activity. Regardless, add activity id to
                        // new activity list.
                        function (callback) {
                            if (locals.activityExists) {
                                // No need to load activity.
                                winston.info ("Adding activity to list.")
                                locals.newActivityIds.push(locals.activity._id);
                                callback();
                            }
                            else {
                                winston.info("Copying activity file to GFS");
                                var fileObjectId = mdb.ObjectId();
                                mdb.copyLocalFileToGfs(htmlPath, fileObjectId, function (err) {
                                    if (err) callback (err);
                                    else {
                                        winston.info("Saving activity.");
                                        // Need to pull a fresh copy of activity, since filter will have updated it.
                                        mdb.Activity.findOne({baseFileHash: locals.hash}, function (err, activity) {
                                            if (err) callback(err);
                                            else if (activity) {
                                                activity.htmlFile = fileObjectId;
                                                activity.save(function (err) {
                                                    if (err) callback(err);
                                                    else {
                                                        winston.info("Activity saved, adding to list.");
                                                        locals.newActivityIds.push(activity._id);
                                                        callback();
                                                    }
                                                })
                                            }
                                            else {
                                                callback("Activity missing.");
                                            }
                                        });
                                    }
                                });
                            }
                        }
                    ], function (err) {
                        if (locals2.skipped) {
                            winston.info(err);
                            callback();
                        }
                        else if (err) {
                            callback(err);
                        }
                        else {
                            callback();
                        }
                    });
                },
                callback
            );
        }],
        function (err) {
            if (err) {
                callback(err);
            }
            else {
                winston.info("Saving activities");
                // Update GitRepo's list of activities to only reflect those we just loaded. (Deleted activities will disappear.)
                repo.currentActivityIds = locals.newActivityIds;
                repo.save(callback);                
            }
        }
    );
}
