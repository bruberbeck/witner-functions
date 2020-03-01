'use strict';

//
//
// #Requires

const Functions = require('firebase-functions');
const Admin = require('firebase-admin');
const Geofire = require('geofire');
const Twitter = require('twitter');

//
//
// #Startup

Admin.initializeApp(Functions.config().firebase);

//
//
// #GlobalFields

const tweetsPath = '/weets/tweets/';
const witneetsPath = '/weets/witneets/';
const geofireWitneetsPath = '/weets/geofire/witneets/';
const witneetsRepliesTweetsPath = '/weets/replies/tweets/';
const witneetsRepliesWitneetsPath = '/weets/replies/witneets/';
const util = (function() {

  // #Fields

  // A 'witneet' is the solution domain specific abstraction
  // for spatial (accompanied with a specific location information)
  // tweets.
  const witneetsRef = Admin.database().ref(witneetsPath);
  const witneetsRepliesWitneetsRef = Admin.database().ref(witneetsRepliesWitneetsPath);
  const witneetsGeofire = new Geofire(Admin.database().ref(geofireWitneetsPath));

  function _getWitneet(tweet, parsedCoords) {
      // Stack hashtags into this variable.
      let tags = [];
      // Iterate over the hashtags and stack them into 'tags.'
      tweet.entities.hashtags.forEach(function(elem) {
          tags.push(elem.text);
      });
      let media = null;
      if (tweet.extended_entities &&
          tweet.extended_entities.media &&
          tweet.extended_entities.media.length > 0) {
          // Url for concatanated media of this tweet.
          media = {
              expandedUrl: tweet.extended_entities.media[0].expanded_url,
              // Stack media links into this property.
              media_Urls: [],
          }
          tweet.extended_entities.media.forEach(function(elem) {
              media.mediaUrls.push(elem.media_url_https);
          });
      }
      let poi = null;
      if (tweet.place &&
          tweet.place.place_type == 'poi' &&
          tweet.place.bounding_box) {
          let coords = tweet.place.bounding_box.coordinates[0][0];
          if (coords.length == 2) {
              poi = {
                  fullName: tweet.place.full_name,
                  coordinates: [ coords[1], coords[0] ],
              };
          }
      }
      let coordinates = null;
      if (tweet.geo) {
        coordinates = tweet.geo.coordinates;
      }
      else if (parsedCoords) {
        coordinates = parsedCoords;
      }

      return {
        tweetId: tweet.id_str,
        text: tweet.text,
        coordinates: coordinates,
        geoparsed: !!parsedCoords,
        hashtags: tags,
        createdAt: tweet.created_at,
        twitterTimeStamp: Number.parseInt(tweet.timestamp_ms),
        systemTimeStamp: Admin.database.ServerValue.TIMESTAMP,
        user: {
          userId: tweet.user.id_str,
          name: tweet.user.name,
          screenName: tweet.user.screen_name,
        },
        poi: poi,
        media: media,
      };
  }

  function _validateWitneet(tweet) {
      return tweet.geo || (tweet.place && tweet.place.place_type == 'poi');
  };

  function _addWitneetToRef(ref, witneetsGeofireRef, tweet, parsedCoords) {
      // First, set main branch,
      // then, set spatial geofire branch.
      let witneet = _getWitneet(tweet, parsedCoords),
        promise = ref.child(witneet.tweetId).set(witneet);

      if (witneetsGeofireRef
        && (witneet.coordinates || witneet.poi.coordinates)) {
          promise.then(res =>
            witneetsGeofire.set(witneet.tweetId,
                witneet.coordinates ? witneet.coordinates : witneet.poi.coordinates));
        }

      return promise;
  }

  function _addWitneet(tweet, parsedCoords) {
    return _addWitneetToRef(witneetsRef, witneetsGeofire, tweet, parsedCoords);
  }

  function _addReplyWitneet(tweet) {
    return _addWitneetToRef(witneetsRepliesWitneetsRef.child(tweet.in_reply_to_status_id_str),
      undefined, tweet);
  }

	return {
        validateWitneet: _validateWitneet,
        addWitneet: _addWitneet,
        addReplyWitneet: _addReplyWitneet
	};
})();
const geoparser = (function () {
  // Fields
  const request = require('request');
  const _protoOptions = {
   url: 'https://geoparser.io/api/geoparser',
   method: 'POST',
   form: { inputText: 'inputText' },
   headers: {
     'Accept': 'application/json',
     'Authorization': '',
     'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8'
   }
  };

  function _createOptions(inputText) {
    let opts = Object.assign({}, _protoOptions);
    opts.form.inputText = inputText;
    return opts;
  }

  function _getFeatureOrder(feature) {
    // For detailed information about feature types
    // see http://www.geonames.org/ontology/ontology_v3.1.rdf.
    switch (feature.properties.type) {
      case "section of populated place":
        return 8;
      case "populated place":
        return 7;
      case "hotel":
        return 6;
      case "fifth-order administrative division":
        return 5;
      case "fourth-order administrative division":
      case "seat of a fourth-order administrative division":
        return 4;
      case "third-order administrative division":
      case "seat of a third-order administrative division":
        return 3;
      case "second-order administrative division":
      case "seat of a second-order administrative division":
        return 2;
      case "first-order administrative division":
      case "seat of a first-order administrative division":
        return 1;
      default:
        return -1;
    }
  }

  function _getHighestOrderFeature(features) {
    console.log(features);
    let highestFeature = null;
    for (let i = 0; i < features.length; ++i) {
      let feature = features[i],
        order = _getFeatureOrder(feature);

      if (order < 0) {
        continue;
      }

      if (highestFeature === null
        || highestFeature.order < order) {
        feature.order = order;
        highestFeature = feature;
      }
    }

    return highestFeature;
  }

  function _getCoordinates(feature) {
    if (feature.geometry.type === 'Point') {
      return feature.geometry.coordinates.reverse();
    }
    return null;
  }

  function _geoparse(inputText, resolve, reject) {
    return new Promise((resolve, reject) => {
      request(_createOptions(inputText), function(err, response, body) {
        let features = JSON.parse(body).features,
          highestOrderFeature = _getHighestOrderFeature(features),
          coords = highestOrderFeature ? _getCoordinates(highestOrderFeature) : null;

          if (coords != null) {
            resolve(coords);
          }
          else {
            reject(`Unable to geoparse {${inputText}}`);
          }
      });
    });
  }

  return {
    parse: _geoparse
  }
}());

exports.addWitneet = Functions.database.ref(tweetsPath + '{tweetId}')
    .onCreate((snapshot, context) => {
        let tweet = snapshot.val();
        console.log(tweet);
        if (util.validateWitneet(tweet)) {
            return util.addWitneet(tweet);
        }
        else {
            return geoparser.parse(tweet.text)
              .then(coords => util.addWitneet(tweet, coords));
        }
    });

exports.addReplyWitneet = Functions.database.ref(witneetsRepliesTweetsPath +
  '{tweetId}/{replyTweetId}' )
    .onCreate((snapshot, context) => {
        let tweet = snapshot.val();
        console.log(tweet);
        return util.addReplyWitneet(tweet);
    });
