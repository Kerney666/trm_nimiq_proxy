const net = require("net");
const util = require("util");
const chalk = require('chalk');
const stripAnsi = require('strip-ansi')
const constamp = require('console-stamp')(console, '[yyyymmdd HH:MM:ss.l]');
const logtofile = require('log-to-file');
const socket = require('log-to-file');
const WebSocket = require('ws');

var logfn = 'proxy.log';
var started = false;

// Well, this is ugly crap, should use a proper logging framework.
var realConLog = console.log;
console.log = function(...args) {
    var s = util.format(...args);
    realConLog(s);
    if (started) logtofile(stripAnsi(s), logfn);
};

// Log uncaught exceptions
process.on("uncaughtException", function(error) {
    console.error(error);
});

// Check cmd line args
if (process.argv.length != 6) {
    console.log("Usage: trm_nimiq_proxy <localport> <wss pool host> <wss pool port> <log traffic: 1/0>");
    process.exit();
}

// Grab/parse cmd line args
var argIdx = 2;
var localport = process.argv[argIdx++];
var poolHost = process.argv[argIdx++];
var poolPort = parseInt(process.argv[argIdx++]);
var connLog = true;
var trafficLog = parseInt(process.argv[argIdx++]) != 0;

// From here, log to file as well.
started = true;

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
    
    conn.outSocket = new WebSocket(`wss://${poolHost}:${poolPort}`);

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

