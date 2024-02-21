
var browserTtsEngine = brapi.tts ? new BrowserTtsEngine() : (typeof speechSynthesis != 'undefined' ? new WebSpeechEngine() : new DummyTtsEngine());
var remoteTtsEngine = new RemoteTtsEngine(config.serviceUrl);
var googleTranslateTtsEngine = new GoogleTranslateTtsEngine();
//var amazonPollyTtsEngine = new AmazonPollyTtsEngine();
var googleWavenetTtsEngine = new GoogleWavenetTtsEngine();
//var ibmWatsonTtsEngine = new IbmWatsonTtsEngine();


/*
interface Options {
  voice: {
    voiceName: string
    autoSelect?: boolean
  }
  lang: string
  rate?: number
  pitch?: number
  volume?: number
}

interface Event {
  type: string
}

interface Voice {
  voiceName: string
  lang: string
}

interface TtsEngine {
  speak: function(text: string, opts: Options, onEvent: (e:Event) => void): void
  stop: function(): void
  pause: function(): void
  resume: function(): void
  isSpeaking: function(callback): void
  getVoices: function(): Voice[]
}
*/

function BrowserTtsEngine() {
  this.speak = function(text, options, onEvent) {
    brapi.tts.speak(text, {
      voiceName: options.voice.voiceName,
      lang: options.lang,
      rate: options.rate,
      pitch: options.pitch,
      volume: options.volume,
      requiredEventTypes: ["start", "end"],
      desiredEventTypes: ["start", "end", "error"],
      onEvent: onEvent
    })
  }
  this.stop = brapi.tts.stop;
  this.pause = brapi.tts.pause;
  this.resume = brapi.tts.resume;
  this.isSpeaking = brapi.tts.isSpeaking;
  this.getVoices = function() {
    return new Promise(function(fulfill) {
      brapi.tts.getVoices(function(voices) {
        fulfill(voices || []);
      })
    })
  }
}


function WebSpeechEngine() {
  var utter;
  this.speak = function(text, options, onEvent) {
    utter = new SpeechSynthesisUtterance();
    utter.text = text;
    utter.voice = options.voice;
    if (options.lang) utter.lang = options.lang;
    if (options.pitch) utter.pitch = options.pitch;
    if (options.rate) utter.rate = options.rate;
    if (options.volume) utter.volume = options.volume;
    utter.onstart = onEvent.bind(null, {type: 'start', charIndex: 0});
    utter.onend = onEvent.bind(null, {type: 'end', charIndex: text.length});
    utter.onerror = function(event) {
      onEvent({type: 'error', errorMessage: event.error});
    };
    speechSynthesis.speak(utter);
  }
  this.stop = function() {
    if (utter) utter.onend = null;
    speechSynthesis.cancel();
  }
  this.pause = function() {
    speechSynthesis.pause();
  }
  this.resume = function() {
    speechSynthesis.resume();
  }
  this.isSpeaking = function(callback) {
    callback(speechSynthesis.speaking);
  }
  this.getVoices = function() {
    return promiseTimeout(1500, "Timeout WebSpeech getVoices", new Promise(function(fulfill) {
      var voices = speechSynthesis.getVoices() || [];
      if (voices.length) fulfill(voices);
      else speechSynthesis.onvoiceschanged = function() {
        fulfill(speechSynthesis.getVoices() || []);
      }
    }))
    .then(function(voices) {
      for (var i=0; i<voices.length; i++) voices[i].voiceName = voices[i].name;
      return voices;
    })
    .catch(function(err) {
      console.error(err);
      return [];
    })
  }
}


function DummyTtsEngine() {
  this.getVoices = function() {
    return Promise.resolve([]);
  }
}


function TimeoutTtsEngine(baseEngine, timeoutMillis) {
  var timer;
  this.speak = function(text, options, onEvent) {
    var started = false;
    clearTimeout(timer);
    timer = setTimeout(function() {
      baseEngine.stop();
      if (started) onEvent({type: "end", charIndex: text.length});
      else onEvent({type: "error", errorMessage: "Timeout, TTS never started, try picking another voice?"});
    },
    timeoutMillis);
    baseEngine.speak(text, options, function(event) {
        if (event.type == "start") started = true;
        if (event.type == "end" || event.type == "error") clearTimeout(timer);
        onEvent(event);
    })
  }
  this.stop = function() {
    clearTimeout(timer);
    baseEngine.stop();
  }
  this.isSpeaking = baseEngine.isSpeaking;
}


function RemoteTtsEngine(serviceUrl) {
  var manifest = brapi.runtime.getManifest();
  var iOS = !!navigator.platform && /iPad|iPhone|iPod/.test(navigator.platform);
  var audio = document.createElement("AUDIO");
  var isSpeaking = false;
  var nextStartTime = 0;
  var waitTimer;
  var authToken;
  var clientId;
  var speakPromise;
  function ready(options) {
    return getAuthToken()
      .then(function(token) {authToken = token})
      .then(getUniqueClientId)
      .then(function(id) {clientId = id})
      .then(function() {
        if (isPremiumVoice(options.voice) && !options.voice.autoSelect) {
          if (!authToken) throw new Error(JSON.stringify({code: "error_login_required"}));
          return getAccountInfo(authToken)
            .then(function(account) {
              if (!account) throw new Error(JSON.stringify({code: "error_login_required"}));
              if (!account.balance) throw new Error(JSON.stringify({code: "error_payment_required"}));
            })
        }
      })
  }
  this.speak = function(utterance, options, onEvent) {
    if (!options.volume) options.volume = 1;
    if (!options.rate) options.rate = 1;
    audio.pause();
    if (!iOS) {
      audio.volume = options.volume;
      audio.defaultPlaybackRate = options.rate;
    }
    speakPromise = ready(options)
      .then(function() {
        audio.src = getAudioUrl(utterance, options.lang, options.voice);
        return new Promise(function(fulfill) {audio.oncanplay = fulfill});
      })
      .then(function() {
        var waitTime = nextStartTime - Date.now();
        if (waitTime > 0) return new Promise(function(f) {waitTimer = setTimeout(f, waitTime)});
      })
      .then(function() {
        isSpeaking = true;
        return audio.play();
      })
      .catch(function(err) {
        onEvent({
          type: "error",
          errorMessage: err.name == "NotAllowedError" ? JSON.stringify({code: "error_user_gesture_required"}) : err.message
        })
      })
    audio.onplay = onEvent.bind(null, {type: 'start', charIndex: 0});
    audio.onended = function() {
      onEvent({type: 'end', charIndex: utterance.length});
      isSpeaking = false;
    };
    audio.onerror = function() {
      onEvent({type: "error", errorMessage: audio.error.message});
      isSpeaking = false;
    };
    audio.load();
  }
  this.isSpeaking = function(callback) {
    callback(isSpeaking);
  }
  this.pause =
  this.stop = function() {
    speakPromise.then(function() {
    clearTimeout(waitTimer);
    audio.pause();
    })
  }
  this.resume = function() {
    audio.play();
  }
  this.prefetch = function(utterance, options) {
    if (!iOS) {
      ajaxGet(getAudioUrl(utterance, options.lang, options.voice, true));
    }
  }
  this.setNextStartTime = function(time, options) {
    if (!iOS)
      nextStartTime = time || 0;
  }
  this.getVoices = function() {
    return voices;
  }
  function getAudioUrl(utterance, lang, voice, prefetch) {
    assert(utterance && lang && voice);
    return serviceUrl + "/read-aloud/speak/" + lang + "/" + encodeURIComponent(voice.voiceName) + "?c=" + encodeURIComponent(clientId) + "&t=" + encodeURIComponent(authToken) + (voice.autoSelect ? '&a=1' : '') + "&v=" + manifest.version + "&pf=" + (prefetch ? 1 : 0) + "&q=" + encodeURIComponent(utterance);
  }
  var voices = [
      {"voice_name": "Amazon Australian English (Nicole)", "lang": "en-AU", "gender": "female", "event_types": ["start", "end", "error"]},
      {"voice_name": "Amazon Australian English (Russell)", "lang": "en-AU", "gender": "male", "event_types": ["start", "end", "error"]},
    ]
    .map(function(item) {
      return {voiceName: item.voice_name, lang: item.lang};
    })
}


function GoogleTranslateTtsEngine() {
  var audio = document.createElement("AUDIO");
  var prefetchAudio;
  var isSpeaking = false;
  var speakPromise;
  this.ready = function() {
    return googleTranslateReady();
  };
  this.speak = function(utterance, options, onEvent) {
    if (!options.volume) options.volume = 1;
    if (!options.rate) options.rate = 1;
    audio.pause();
    audio.volume = options.volume;
    audio.defaultPlaybackRate = options.rate * 1.1;
    audio.onplay = function() {
      onEvent({type: 'start', charIndex: 0});
      isSpeaking = true;
    };
    audio.onended = function() {
      onEvent({type: 'end', charIndex: utterance.length});
      isSpeaking = false;
    };
    audio.onerror = function() {
      onEvent({type: "error", errorMessage: audio.error.message});
      isSpeaking = false;
    };
    speakPromise = Promise.resolve()
      .then(function() {
        if (prefetchAudio && prefetchAudio[0] == utterance && prefetchAudio[1] == options) return prefetchAudio[2];
        else return getAudioUrl(utterance, options.voice.lang);
      })
      .then(function(url) {
        audio.src = url;
        return audio.play();
      })
      .catch(function(err) {
        onEvent({
          type: "error",
          errorMessage: err.name == "NotAllowedError" ? JSON.stringify({code: "error_user_gesture_required"}) : err.message
        })
      })
  };
  this.isSpeaking = function(callback) {
    callback(isSpeaking);
  };
  this.pause =
  this.stop = function() {
    speakPromise.then(function() {audio.pause()});
  };
  this.resume = function() {
    audio.play();
  };
  this.prefetch = function(utterance, options) {
    getAudioUrl(utterance, options.voice.lang)
      .then(function(url) {
        prefetchAudio = [utterance, options, url];
      })
      .catch(console.error)
  };
  this.setNextStartTime = function() {
  };
  this.getVoices = function() {
    return voices;
  }
  function getAudioUrl(text, lang) {
    assert(text && lang);
    return googleTranslateSynthesizeSpeech(text, lang);
  }
  var voices = [
      {"voice_name": "GoogleTranslate Bengali", "lang": "bn", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate English", "lang": "en", "event_types": ["start", "end", "error"]},
    ]
    .map(function(item) {
      return {voiceName: item.voice_name, lang: item.lang};
    })
}


// function AmazonPollyTtsEngine() {
//   var pollyPromise;
//   var audio = document.createElement("AUDIO");
//   var prefetchAudio;
//   var isSpeaking = false;
//   var speakPromise;
//   this.speak = function(utterance, options, onEvent) {
//     if (!options.volume) options.volume = 1;
//     if (!options.rate) options.rate = 1;
//     if (!options.pitch) options.pitch = 1;
//     audio.pause();
//     audio.volume = options.volume;
//     audio.defaultPlaybackRate = options.rate;
//     audio.onplay = function() {
//       onEvent({type: 'start', charIndex: 0});
//       isSpeaking = true;
//     };
//     audio.onended = function() {
//       onEvent({type: 'end', charIndex: utterance.length});
//       isSpeaking = false;
//     };
//     audio.onerror = function() {
//       onEvent({type: "error", errorMessage: audio.error.message});
//       isSpeaking = false;
//     };
//     speakPromise = Promise.resolve()
//       .then(function() {
//         if (prefetchAudio && prefetchAudio[0] == utterance && prefetchAudio[1] == options) return prefetchAudio[2];
//         else return getAudioUrl(utterance, options.lang, options.voice, options.pitch);
//       })
//       .then(function(url) {
//         audio.src = url;
//         return audio.play();
//       })
//       .catch(function(err) {
//         onEvent({
//           type: "error",
//           errorMessage: err.name == "NotAllowedError" ? JSON.stringify({code: "error_user_gesture_required"}) : err.message
//         })
//       })
//   };
//   this.isSpeaking = function(callback) {
//     callback(isSpeaking);
//   };
//   this.pause =
//   this.stop = function() {
//     speakPromise.then(function() {audio.pause()});
//   };
//   this.resume = function() {
//     audio.play();
//   };
//   this.prefetch = function(utterance, options) {
//     getAudioUrl(utterance, options.lang, options.voice, options.pitch)
//       .then(function(url) {
//         prefetchAudio = [utterance, options, url];
//       })
//       .catch(console.error)
//   };
//   this.setNextStartTime = function() {
//   };
//   this.getVoices = function() {
//     return getSettings(["pollyVoices"])
//       .then(function(items) {
//         if (!items.pollyVoices || Date.now()-items.pollyVoices[0].ts > 24*3600*1000) updateVoices();
//         return items.pollyVoices || voices;
//       })
//   }
//   function updateVoices() {
//     ajaxGet(config.serviceUrl + "/Kakatua/list-voices/amazon")
//       .then(JSON.parse)
//       .then(function(list) {
//         list[0].ts = Date.now();
//         updateSettings({pollyVoices: list});
//       })
//   }
//   function getAudioUrl(text, lang, voice, pitch) {
//     assert(text && lang && voice && pitch != null);
//     var matches = voice.voiceName.match(/^AmazonPolly .* \((\w+)\)( \+\w+)?$/);
//     var voiceId = matches[1];
//     var style = matches[2] && matches[2].substr(2);
//     return getPolly()
//       .then(function(polly) {
//         return polly.synthesizeSpeech(getOpts(text, voiceId, style))
//         .promise()
//       })
//       .then(function(data) {
//         var blob = new Blob([data.AudioStream], {type: data.ContentType});
//         return URL.createObjectURL(blob);
//       })
//   }
//   function getPolly() {
//     return pollyPromise || (pollyPromise = createPolly());
//   }
//   function createPolly() {
//     return getSettings(["awsCreds"])
//       .then(function(items) {
//         if (!items.awsCreds) throw new Error("Missing AWS credentials");
//         return new AWS.Polly({
//           region: "us-east-1",
//           accessKeyId: items.awsCreds.accessKeyId,
//           secretAccessKey: items.awsCreds.secretAccessKey
//         })
//       })
//   }
//   function getOpts(text, voiceId, style) {
//     switch (style) {
//       case "newscaster":
//         return {
//           OutputFormat: "mp3",
//           Text: '<speak><amazon:domain name="news">' + escapeXml(text) + '</amazon:domain></speak>',
//           TextType: "ssml",
//           VoiceId: voiceId,
//           Engine: "neural"
//         }
//       case "conversational":
//         return {
//           OutputFormat: "mp3",
//           Text: '<speak><amazon:domain name="conversational">' + escapeXml(text) + '</amazon:domain></speak>',
//           TextType: "ssml",
//           VoiceId: voiceId,
//           Engine: "neural"
//         }
//       case "neural":
//         return {
//           OutputFormat: "mp3",
//           Text: text,
//           VoiceId: voiceId,
//           Engine: "neural"
//         }
//       default:
//         return {
//           OutputFormat: "mp3",
//           Text: text,
//           VoiceId: voiceId
//         }
//     }
//   }
//   function escapeXml(unsafe) {
//     return unsafe.replace(/[<>&'"]/g, function (c) {
//       switch (c) {
//           case '<': return '&lt;';
//           case '>': return '&gt;';
//           case '&': return '&amp;';
//           case '\'': return '&apos;';
//           case '"': return '&quot;';
//       }
//     })
//   }
//   var voices = [
//     {"voiceName":"AmazonPolly US English (Salli) +neural","lang":"en-US","gender":"female"}
//   ]
// }


function GoogleWavenetTtsEngine() {
  var audio = document.createElement("AUDIO");
  var prefetchAudio;
  var isSpeaking = false;
  var speakPromise;
  this.speak = function(utterance, options, onEvent) {
    if (!options.volume) options.volume = 1;
    if (!options.rate) options.rate = 1;
    if (!options.pitch) options.pitch = 1;
    audio.pause();
    audio.volume = options.volume;
    audio.defaultPlaybackRate = options.rate;
    audio.onplay = function() {
      onEvent({type: 'start', charIndex: 0});
      isSpeaking = true;
    };
    audio.onended = function() {
      onEvent({type: 'end', charIndex: utterance.length});
      isSpeaking = false;
    };
    audio.onerror = function() {
      onEvent({type: "error", errorMessage: audio.error.message});
      isSpeaking = false;
    };
    speakPromise = Promise.resolve()
      .then(function() {
        if (prefetchAudio && prefetchAudio[0] == utterance && prefetchAudio[1] == options) return prefetchAudio[2];
        else return getAudioUrl(utterance, options.voice, options.pitch);
      })
      .then(function(url) {
        audio.src = url;
        return audio.play();
      })
      .catch(function(err) {
        onEvent({
          type: "error",
          errorMessage: err.name == "NotAllowedError" ? JSON.stringify({code: "error_user_gesture_required"}) : err.message
        })
      })
  };
  this.isSpeaking = function(callback) {
    callback(isSpeaking);
  };
  this.pause =
  this.stop = function() {
    speakPromise.then(function() {audio.pause()});
  };
  this.resume = function() {
    audio.play();
  };
  this.prefetch = function(utterance, options) {
    getAudioUrl(utterance, options.voice, options.pitch)
      .then(function(url) {
        prefetchAudio = [utterance, options, url];
      })
      .catch(console.error)
  };
  this.setNextStartTime = function() {
  };
  this.getVoices = function() {
    return getSettings(["wavenetVoices"])
      .then(function(items) {
        if (!items.wavenetVoices || Date.now()-items.wavenetVoices[0].ts > 24*3600*1000) updateVoices();
        return items.wavenetVoices || voices;
      })
  }
  this.getFreeVoices = function() {
    return this.getVoices()
      .then(function(items) {
        return items.filter(function(item) {
          return item.voiceName.match(/^GoogleStandard /);
        })
      })
  }
  function updateVoices() {
    ajaxGet(config.serviceUrl + "/read-aloud/list-voices/google")
      .then(JSON.parse)
      .then(function(list) {
        list[0].ts = Date.now();
        updateSettings({wavenetVoices: list});
      })
  }
  function getAudioUrl(text, voice, pitch) {
    assert(text && voice && pitch != null);
    var matches = voice.voiceName.match(/^Google(\w+) .* \((\w+)\)$/);
    var voiceName = voice.lang + "-" + matches[1] + "-" + matches[2][0];
    var endpoint = matches[1] == "Neural2" ? "us-central1-texttospeech.googleapis.com" : "texttospeech.googleapis.com";
    return getSettings(["gcpCreds", "gcpToken"])
      .then(function(settings) {
        var postData = {
          input: {
            text: text
          },
          voice: {
            languageCode: voice.lang,
            name: voiceName
          },
          audioConfig: {
            audioEncoding: "OGG_OPUS",
            pitch: (pitch-1)*20
          }
        }
        if (settings.gcpCreds) return ajaxPost("https://" + endpoint + "/v1/text:synthesize?key=" + settings.gcpCreds.apiKey, postData, "json");
        if (!settings.gcpToken) throw new Error(JSON.stringify({code: "error_wavenet_auth_required"}));
        return ajaxPost("https://cxl-services.appspot.com/proxy?url=https://texttospeech.googleapis.com/v1beta1/text:synthesize&token=" + settings.gcpToken, postData, "json")
          .catch(function(err) {
            console.error(err);
            throw new Error(JSON.stringify({code: "error_wavenet_auth_required"}));
          })
      })
      .then(function(responseText) {
        var data = JSON.parse(responseText);
        return "data:audio/ogg;codecs=opus;base64," + data.audioContent;
      })
  }
  var voices = [
    //{"voiceName":"GoogleStandard US English (Benjamin)","lang":"en-US","gender":"male"},
    {"voiceName":"GoogleStandard US English (Caroline)","lang":"en-US","gender":"female"},
    //{"voiceName":"GoogleStandard US English (Daniel)","lang":"en-US","gender":"male"},
    //{"voiceName":"GoogleStandard US English (Elizabeth)","lang":"en-US","gender":"female"},
  ]
}


