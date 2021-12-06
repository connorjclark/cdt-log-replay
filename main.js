const puppeteer = require('puppeteer');

function loadLog(pathToLog, opts) {
  const {filterCommands, beforeEach, afterEach} = opts || {};
  const log = require(pathToLog);

  const commandsSent = [];
  for (const sent of log.filter(l => l.type === 'send')) {
    const recieved = log.find(entry => entry.id === sent.id && entry.type === 'recv');
    if (filterCommands && !filterCommands({sent, recieved})) {
      continue;
    }
    
    commandsSent.push({
      sent,
      recieved,
    });
  }

  const savedTargetIdToNew = new Map();
  const savedSessionIdToNew = new Map();
  const savedFrameIdToNew = new Map();
  const savedExecContextIdToNew = new Map();

  function replace(params) {
    if (params.targetId) {
      params.targetId = savedTargetIdToNew.get(params.targetId);
    }
    if (params.sessionId) {
      params.sessionId = savedSessionIdToNew.get(params.sessionId);
    }
    if (params.frameId) {
      params.frameId = savedFrameIdToNew.get(params.frameId);
    }
    if (params.contextId) {
      params.contextId = savedExecContextIdToNew.get(params.contextId);
    }
  }

  return {
    commandsSent,
    savedTargetIdToNew,
    savedSessionIdToNew,
    async replay(session) {
      session.on('ServiceWorker.workerRegistrationUpdated', console.log);
      
      for (const { sent, recieved } of commandsSent) {
        const params = { ...sent.params };
        replace(params);

        if (beforeEach) await beforeEach({sent, recieved});
    
        const response = await session.send(sent.method, params);
    
        if (sent.method === 'Target.getTargetInfo') {
          savedTargetIdToNew.set(recieved.result.targetInfo.targetId, response.targetInfo.targetId);
        }
        if (sent.method === 'Target.attachToTarget') {
          savedSessionIdToNew.set(recieved.result.sessionId, response.sessionId);
        }
        if (sent.method === 'Page.getResourceTree') {
          savedFrameIdToNew.set(recieved.result.frameTree.frame.id, response.frameTree.frame.id);
        }
        if (sent.method === 'Page.createIsolatedWorld') {
          savedExecContextIdToNew.set(recieved.result.contextId, response.contextId);
        }

        if (afterEach) await afterEach({sent, recieved}, response);
      }
    },
  };
}

async function getInstallabilityErrors(session) {
  const installablityErrors = await session.send('Page.getInstallabilityErrors');
  console.log(installablityErrors);
}

async function testReplay(logPath) {
  const browser = await puppeteer.launch({
    headless: false,
    // args: ['--disable-features=PlzServiceWorker'],
  });

  const page = await browser.newPage();

  // has manifest and a SW, but the SW has no offline support (no fetch handler)
  await page.goto('https://judicious-guide.surge.sh/', {
    waitUntil: 'networkidle2',
  });

  // Open session, run same commands that LH would, up to Page.getInstallabilityErrors
  // Includes navigation to https://judicious-guide.surge.sh/
  const lhSession = await page.target().createCDPSession();
  const lhLog = loadLog(logPath, {
    // A lot things we can ignore in the replay, and the hanging will still happen.
    filterCommands: ({sent}) => {
      if (sent.method.startsWith('CSS.')) return false;
      if (sent.method.startsWith('Debugger.')) return false;
      if (sent.method.startsWith('DOM.resolveNode')) return false;
      if (sent.method.startsWith('DOMDebugger.')) return false;
      if (sent.method.startsWith('Emulation.')) return false;
      if (sent.method.startsWith('IO.')) return false;
      if (sent.method.startsWith('Log.')) return false;
      if (sent.method.startsWith('Network.') && sent.method !== 'Network.enable') return false;
      if (sent.method.startsWith('Profiler.')) return false;
      if (sent.method.startsWith('Runtime.callFunctionOn')) return false;
      if (sent.method.startsWith('Runtime.evaluate')) return false;

      return true;
    },
    beforeEach: async ({sent}) => {
      console.log(sent.id, sent.method);

      if (sent.method === 'Page.getInstallabilityErrors') {
        console.log('wait ...');
        await new Promise(resolve => setTimeout(resolve, 10_000));
        console.log('ok');
      }
    },
    afterEach: async (_, response) => {
      if (Object.keys(response).length) console.log(response);

      // Artifical delay, give Chrome some time to think.
      await new Promise(resolve => setTimeout(resolve, 50));

      // Try to get installable errors, see exactly when it starts to hang.
      await getInstallabilityErrors(lhSession);
    },
  });

  await lhLog.replay(lhSession);

  console.log('done replaying');

  await browser.close();
}

// Attempt to recreate the hanging without log replay.
// Not working yet. 
async function testManual() {
  const browser = await puppeteer.launch({
    headless: false,
    // args: ['--disable-features=PlzServiceWorker'],
  });

  const page = await browser.newPage();

  const sessionOne = await page.target().createCDPSession();
  // const sessionTwo = await page.target().createCDPSession();

  function setupSession(session) {
    session.send('Target.setAutoAttach', {autoAttach: true, flatten: true, waitForDebuggerOnStart: true});
    session.on('Target.attachedToTarget', async (event) => {
      const swSession = page.browserContext()._connection._sessions.get(event.sessionId);
      console.log('sw sessionId:', swSession._sessionId);
      swSession.send('Runtime.runIfWaitingForDebugger', {sessionId: event.sessionId});
    });
  }

  setupSession(sessionOne);
  // setupSession(sessionTwo);

  // ??? this is meant to be important to the repro ....
  await sessionOne.send('Storage.clearDataForOrigin', {
    origin: 'https://judicious-guide.surge.sh',
    storageTypes: 'file_systems,shader_cache,service_workers,cache_storage',
  });

  // has manifest and a SW, but the SW has no offline support (no fetch handler)
  await page.goto('https://judicious-guide.surge.sh/', {
    waitUntil: 'networkidle2',
  });

  await getInstallabilityErrors(sessionOne);

  await browser.close();
}

async function main() {
  // All of these logs repro. I thought the state of Chrome might be important in
  // the exact commands LH generated, but it was not.
  // Hanging does not happen when s_w is already installed, so `Storage.clearDataForOrigin`
  // is important to repro.
  await testReplay('./logs/lh-log-cli.json');
  // await testReplay('./logs/lh-log-cdt-plz.json');
  // await testReplay('./logs/lh-log-cdt-no-plz.json');

  // await testManual();
}

main();
