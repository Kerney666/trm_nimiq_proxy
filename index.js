const net = require("net");
const util = require("util");
const chalk = require('chalk');
const stripAnsi = require('strip-ansi')
const constamp = require('console-stamp')(console, '[yyyymmdd HH:MM:ss.l]');
const WebSocket = require('ws');
const fs = require('fs');

var logfn = 'proxy.log';
var fileLogEnabled = false;

// Duplicating the code from log-to-file, needed better error handling.

/**
 * Append zero to length.
 * @param {string} value Value to append zero.
 * @param {number} length Needed length.
 * @returns {string} String with appended zeros id need it.
 */
function appendZeroToLength(value, length) {
  return `${value}`.padStart(length, 0);
}

/**
 * Get date as text.
 * @returns {string} Date as text. Sample: "2018.12.03, 07:32:13.0162 UTC".
 */
function getDateAsText() {
  const now = new Date();
  const nowText = appendZeroToLength(now.getUTCFullYear(), 4) + '.'
    + appendZeroToLength(now.getUTCMonth() + 1, 2) + '.'
    + appendZeroToLength(now.getUTCDate(), 2) + ', '
    + appendZeroToLength(now.getUTCHours(), 2) + ':'
    + appendZeroToLength(now.getUTCMinutes(), 2) + ':'
    + appendZeroToLength(now.getUTCSeconds(), 2) + '.'
    + appendZeroToLength(now.getUTCMilliseconds(), 4) + ' UTC';
  return nowText;
}

/**
 * Log to file.
 * @param {string} text Text to log.
 * @param {string} [file] Log file path.
 */
function logToFile(text, file, errHandler) {
    // Define file name.
    const filename = file !== undefined ? file : 'default.log';
    
    // Define log text.
    const logText = getDateAsText() + ' -> ' + text + '\r\n';
    
    // Save log to file.
    fs.appendFile(filename, logText, 'utf8', function (error) {
        if (!error) return;
        if (errHandler) {
            errHandler(error);
        } else {
            // If error - show in console.
            console.log(getDateAsText() + ' -> ' + JSON.stringify(error, null, 2));
        }
    });
}

// Well, this is ugly crap, should use a proper logging framework.
var realConLog = console.log;
console.log = function(...args) {
    var s = util.format(...args);
    realConLog(s);
    if (fileLogEnabled) {
        logToFile(stripAnsi(s), logfn, function(err) {
            if (err && err.code && err.code == "EACCES") {
                realConLog("Disabling logging to file, write failed.");
                fileLogEnabled = false;
            }
        });
    }
};

// Log uncaught exceptions
process.on("uncaughtException", function(error) {
    console.error(error);
});

// Check cmd line args
if (process.argv.length < 6 || process.argv.length > 7) {
    console.log("Usage: trm_nimiq_proxy <localport> <wss pool host> <wss pool port> <log traffic: 1/0> (<file log: filename or 0 to disable>)");
    console.log("Logging to console is always enabled. Logging to the file 'proxy.log' is default behavior.");
    console.log("To log to another file, pass a filename as the last argument. To disable file logging, pass 0 instead.");
    process.exit();
}

// Grab/parse cmd line args
var argIdx = 2;
var localport = process.argv[argIdx++];
var poolHostUrl = process.argv[argIdx++];
var poolPort = parseInt(process.argv[argIdx++]);
var connLog = true;
var trafficLog = parseInt(process.argv[argIdx++]) != 0;

// From here, log to file as well.
fileLogEnabled = true;
if (argIdx < process.argv.length) {
    logfn = process.argv[argIdx++];
    if (logfn == "0") fileLogEnabled = false;
}

// Split host name and uri part (if any).
var poolUrl = "";
var poolHost = poolHostUrl;
var idx = poolHostUrl.indexOf('/');
if (idx >= 0) {
    poolHost = poolHostUrl.substring(0, idx); 
    poolUrl = poolHostUrl.substring(idx);
}

console.log("Host '%s' url '%s'", poolHost, poolUrl);

// Global start time, we normally count from the first received share by resetting it at that point.
var startMs;

// Global vars
var nextSessionId = 0x01;
var conns = {};

var checkPendingData = function(conn) {
	if (!conn.outConnected) return;
	
    // Split the received data into lines, assume one JSON object per line.
    try {
		for (;;) {
			var idx = conn.pendingData.indexOf('\n');
			if (idx < 0) break;
			var msg = conn.pendingData.substring(0, idx);
			conn.pendingData = conn.pendingData.substring(idx+1);
			conn.outSocket.send(msg + "\n");
        }
        
    } catch (err) {
        console.log("[%d] %s:%d - failed parsing writing data to remote (%s)",
                    conn.sessionId,
                    conn.inSocket.remoteAddress,
                    conn.inSocket.remotePort,
                    err
                   );
    }
};

var logDate = function() {
    return new Date().toISOString().
        replace(/T/, ' ').      // replace T with a space
        replace(/\..+/, '');     // delete the dot and everything after
}

var checkPendingBackData = function(conn) {
    // Split the received data into lines, assume one JSON object per line.
    try {
		for (;;) {
			var idx = conn.pendingBackData.indexOf('\n');
			if (idx < 0) break;
			var msg = conn.pendingBackData.substring(0, idx);
			conn.pendingBackData = conn.pendingBackData.substring(idx+1);
		    conn.inSocket.write(msg + "\n");
        }
    } catch (err) {
        console.log("[%d] %s:%d - failed processing pending back data (%s)",
                    conn.sessionId,
                    conn.inSocket.remoteAddress,
                    conn.inSocket.remotePort,
                    err
                   );
    }
};

// Main handler. Sets up all state and functions for a new connection.
var server = net.createServer(function (localsocket) {
    
    // Conn state object
    var conn = {
        sessionId: nextSessionId++,
		inSocket: localsocket,
		outSocket: null,
		outConnected: false,
		pendingData: "",
		pendingBackData: "",
        dead: false
    };

    // Store all active connections
    conns[conn.sessionId] = conn;

    if (connLog) {
	    console.log("[%d] %s:%d - " + chalk.magenta("Session %d connected."), 
				    conn.sessionId,
				    localsocket.remoteAddress,
				    localsocket.remotePort,
				    conn.sessionId);
    }
    if (!startMs) {
        startMs = conn.connMs;
    }    

    conn.shutdown = () => {
        if (!conn.dead && connLog) {
		    console.log("[%d] %s:%d - pool proxy connection shutdown.", 
				        conn.sessionId,
				        conn.inSocket.remoteAddress,
				        conn.inSocket.remotePort);
        }
        conn.dead = true;
        if (conn.outSocket) {
            conn.outSocket.terminate();
            conn.outSocket = null;
            conn.outSocketConnected = false;
        }
        conn.inSocket.end();
    };
    
    conn.outSocket = new WebSocket(`wss://${poolHost}:${poolPort}${poolUrl}`);

    conn.outSocket.on('open', () => {
        if (connLog) {
		    console.log("[%d] %s:%d - pool proxy connection established.", 
				        conn.sessionId,
				        conn.inSocket.remoteAddress,
				        conn.inSocket.remotePort);
        }
        conn.heartbeat();
		conn.outConnected = true;
		checkPendingData(conn);
    });
    
    conn.outSocket.on('close', () => {
        if (!conn.dead && connLog) {
		    console.log("[%d] %s:%d - pool proxy connection closed, closing local socket.", 
				        conn.sessionId,
				        conn.inSocket.remoteAddress,
				        conn.inSocket.remotePort);
        }
        conn.shutdown();
    });

    conn.heartbeat = () => {
        if (trafficLog) {
		    console.log("[%d] %s:%d - pool proxy heartbeat.", 
				        conn.sessionId,
				        conn.inSocket.remoteAddress,
				        conn.inSocket.remotePort);
        }
        clearTimeout(conn.pingTimeout);
        conn.pingTimeout = setTimeout(() => {
            if (!conn.dead && connLog) {
		        console.log("[%d] %s:%d - pool proxy heartbeat timeout, shutting down.", 
				            conn.sessionId,
				            conn.inSocket.remoteAddress,
				            conn.inSocket.remotePort);
            }
            conn.shutdown();
        }, 30000);
    };
    
    conn.outSocket.on('ping', conn.heartbeat);
    
    conn.outSocket.on('error', (e) => {
        if (!conn.dead && connLog) {
		    console.log("[%d] %s:%d - pool proxy connection error, closing (%s).", 
				        conn.sessionId,
				        conn.inSocket.remoteAddress,
				        conn.inSocket.remotePort,
                        e.message || e);
        }
        conn.shutdown();
    });
    
    
    conn.outSocket.on('message', function(data) {
		// Pass-through.
        if (trafficLog) {
            console.log("[%d] %s:%d - received data from pool:\n%s",
                        conn.sessionId,
                        localsocket.remoteAddress,
                        localsocket.remotePort,
                        data
                       );
        }
        conn.heartbeat();
        conn.pendingBackData += data;
        conn.pendingBackData += "\n";
        checkPendingBackData(conn);
	});
	
    conn.inSocket.on('data', function(data) {
        // Parse and rebuild data
        if (trafficLog) {
            console.log("[%d] %s:%d - received data from miner:\n%s",
                        conn.sessionId,
                        localsocket.remoteAddress,
                        localsocket.remotePort,
                        data
                       );
        }

		conn.pendingData += ""+data;
		checkPendingData(conn);
    });

    conn.inSocket.on('close', function(had_error) {
        if (!conn.dead && connLog) {
		    console.log("[%d] %s:%d - local connection closed.", 
				        conn.sessionId,
				        conn.inSocket.remoteAddress,
				        conn.inSocket.remotePort);
        }
        conn.shutdown();
        delete conns[conn.sessionId];
    });

});

var startServer = function() {
    // Start listening server.
    console.log(chalk.magenta("Accepting connections on 0.0.0.0:%d"), localport);
    server.listen(localport);
}

startServer();

