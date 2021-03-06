// Thanks to Michael Robinson

var https = require('https'),
    exec = require('child_process').exec,
    path = require('path'),
    util = require('util');

function pull(localDirectory, callback) {
    exec(util.format('git --git-dir=%s/.git --work-tree=%s pull', localDirectory, localDirectory), callback);
}

function clone(cloneUrl, localDirectory, callback) {
    exec(util.format('git clone %s %s', cloneUrl, localDirectory), callback);
}

function determineAction(cloneUrl, localDirectory, callback) {
    return function(exists) {
        if (exists) {
            pull(localDirectory, callback);
        } else {
            clone(cloneUrl, localDirectory);
        }
    };
}

function cloneOrPull(cloneUrl, localDirectory, callback) {
    path.exists(localDirectory, determineAction(cloneUrl, localDirectory, callback));
}

module.exports = {
    clone: clone,
    pull: pull,
    cloneOrPull: cloneOrPull
};