(ns rigging-workshop.server
  "Tiny HTTP bridge between the browser editor and toda-twist-maker.
   POST /compile   text/plain   TRDL JSONL → octet-stream of .toda bytes
   POST /decompile octet-stream .toda bytes → text/plain TRDL JSONL"
  (:require [twist-maker.core      :as core]
            [twist-maker.trdl      :as trdl]
            [twist-maker.decompile :as decompile]
            [lat.core              :as lat]
            [common.util           :as u]
            [clojure.data.json     :as json]
            [clojure.java.io       :as io]
            [clojure.string        :as str])
  (:import  [com.sun.net.httpserver HttpServer HttpHandler HttpExchange]
            [java.net InetSocketAddress]
            [java.io  ByteArrayOutputStream FileOutputStream File]
            [java.util Base64]))

(def PORT 7878)

(defn- read-bytes [^HttpExchange ex]
  (let [baos (ByteArrayOutputStream.)]
    (io/copy (.getRequestBody ex) baos)
    (.toByteArray baos)))

(defn- read-text [^HttpExchange ex]
  (slurp (.getRequestBody ex)))

(defn- add-cors! [^HttpExchange ex]
  (let [h (.getResponseHeaders ex)]
    (.add h "Access-Control-Allow-Origin"  "*")
    (.add h "Access-Control-Allow-Methods" "POST, OPTIONS")
    (.add h "Access-Control-Allow-Headers" "Content-Type")))

(defn- send-response! [^HttpExchange ex ^long status ^String content-type body]
  (add-cors! ex)
  (.add (.getResponseHeaders ex) "Content-Type" content-type)
  (let [^bytes payload (cond
                         (string? body) (.getBytes ^String body "UTF-8")
                         (bytes? body)  body
                         :else (byte-array body))]
    (.sendResponseHeaders ex status (alength payload))
    (with-open [os (.getResponseBody ex)]
      (.write os payload))))

(defn- send-options! [^HttpExchange ex]
  (add-cors! ex)
  (.sendResponseHeaders ex 204 -1)
  (.close (.getResponseBody ex)))

(defn- send-error! [^HttpExchange ex status msg]
  (send-response! ex status "text/plain; charset=utf-8" (str msg)))

(defn- ref->kw
  "Match trdl/ref->keyword: 'a[3]' → :a_3, 'mytwist' → :mytwist."
  [s]
  (when s
    (if-let [[_ ln idx] (re-matches #"(.+)\[(\d+)\]" s)]
      (keyword (str ln "_" idx))
      (keyword s))))

(defn- twist-hash [twists kw]
  (when-let [t (get twists kw)]
    (str (lat/focus t))))

(defn- entity-hashes
  "List of twist hashes 'involved' in this TRDL entity, for editor↔viz↔hex sync."
  [entity twists]
  (case (:entity-type entity)
    :rig   []
    :line  (let [name (:entity-id entity)
                 n    (get entity "twists" 2)]
             (vec (keep #(twist-hash twists (keyword (str name "_" %))) (range n))))
    :hitch (vec (keep #(twist-hash twists (ref->kw (get entity %)))
                      ["lead" "meet" "fastener" "hoist"]))
    :twist (let [id (:entity-id entity)]
             (if-let [h (twist-hash twists (ref->kw id))] [h] []))
    []))

(defn- b64 ^String [tb]
  (.encodeToString (Base64/getEncoder) (u/bytes->byte-array tb)))

(defn- handle-compile [^HttpExchange ex]
  (try
    (let [text     (read-text ex)
          entities (trdl/parse-trdl-string text)
          spec     (trdl/trdl->spec entities)
          {:keys [bytes twists]} (core/build spec)
          line-hashes (mapv #(entity-hashes % twists) entities)
          payload  (json/write-str {:bytes      (b64 bytes)
                                    :lineHashes line-hashes})]
      (send-response! ex 200 "application/json; charset=utf-8" payload))
    (catch Throwable t
      (.printStackTrace t)
      (send-error! ex 400 (.getMessage t)))))

(defn- handle-decompile [^HttpExchange ex]
  (let [^File tmp (File/createTempFile "rw-" ".toda")]
    (try
      (with-open [os (FileOutputStream. tmp)]
        (.write os ^bytes (read-bytes ex)))
      (let [entities (decompile/decompile (.getAbsolutePath tmp))
            jsonl    (str/join "\n" (map json/write-str entities))]
        (send-response! ex 200 "text/plain; charset=utf-8" jsonl))
      (catch Throwable t
        (.printStackTrace t)
        (send-error! ex 400 (.getMessage t)))
      (finally
        (.delete tmp)))))

(defn- handle-health [^HttpExchange ex]
  (send-response! ex 200 "text/plain" "ok"))

(defn- handle-spec [^HttpExchange ex]
  (try
    (let [text     (read-text ex)
          entities (trdl/parse-trdl-string text)
          spec     (trdl/trdl->spec entities)
          dump     (with-out-str (clojure.pprint/pprint spec))]
      (send-response! ex 200 "text/plain; charset=utf-8" dump))
    (catch Throwable t
      (send-error! ex 400 (.getMessage t)))))

(defn- make-handler [f]
  (reify HttpHandler
    (handle [_ ex]
      (case (.getRequestMethod ex)
        "OPTIONS" (send-options! ex)
        "POST"    (f ex)
        "GET"     (f ex)                    ; allow GET on health
        (send-error! ex 405 "method not allowed")))))

(defn -main [& _]
  (let [server (HttpServer/create (InetSocketAddress. PORT) 0)]
    (.createContext server "/compile"   (make-handler handle-compile))
    (.createContext server "/decompile" (make-handler handle-decompile))
    (.createContext server "/health"    (make-handler handle-health))
    (.createContext server "/spec"      (make-handler handle-spec))
    (.setExecutor server nil)
    (.start server)
    (println (str "rigging-workshop server on http://localhost:" PORT))))
