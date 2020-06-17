# TRM Nimiq Proxy

### TL;DR

This is a trivial wss proxy to mine Nimiq dumb mode with TRM. You need
it to mine Nimiq with TRM unless your pool has added support natively. Start the adapter on your local network or somewhere on the internet, point the miner to the listening port and you should be mining.

Example:
 ``trm_nimiq_proxy.exe 4444 nimiq.icemining.ca 2053 1``
  ``teamredminer.exe -a nimiq -o stratum+tcp://localhost:4444 -u "NQ.. <rest of wallet>" -p x --nimiq_worker=testrig``

TRM has also set up a public proxy available over internet connecting to nimiq.icemining.ca. It's not recommended to use it for anything but quick testing, it might be taken down later. It's available at ``18.196.209.223:4444`` and is used in our example start scripts. Naturally, you should NOT use it if you're nervous about TRM devs seeing your wallet address.


## Background

The reason for this proxy/adapter is that we don't want to add websocket (incl ssl/tls) support in TRM, bloating the miner with unnecessary libraries that are hard to find with the proper licenses. We hope that pool(s) can add this adapter or similar code themselves so that miners can connect directly. Before that happens, you need this proxy.

## Usage
Start the proxy on your local host, your local network or anywhere on the internet. You can download the released packaged version or run it from source. If you want to run it from source, install Node.js 10, make sure npm is installed, checkout the repository, run "npm install", then "node index.js \<arguments\>".

The proxy will log both to the console and the file ``proxy.log`` in the current directory. 

The proxy takes the following arguments:

 - Local port: the port the  proxy will listen on, and that you should connect to from the miner. It will bind to 0.0.0.0, i.e. all interfaces on the host.
 - Pool host, e.g. ``nimiq.icemining.ca``.
 - Pool port, e.g. ``2053``.
 - Traffic log: 1 or 0. When enabled, all traffic will be logged to the proxy.log file.

Example from source: ``node index.js 4444 nimiq.icemining.ca 2053 1``
Win release: ``trm_nimiq_proxy-win.exe 4444 nimiq.icemining.ca 2053 1``
Linux release: ``./trm_nimiq_proxy-linux 4444 nimiq.icemining.ca 2053 1``
