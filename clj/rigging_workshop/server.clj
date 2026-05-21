(ns rigging-workshop.server
  "Main HTTP bridge: compile/decompile + canonical toda-rig-checker.
   POST /compile      text/plain   TRDL JSONL → octet-stream of .toda bytes
   POST /decompile    octet-stream .toda bytes → text/plain TRDL JSONL
   POST /rigcheck-clj?cork=<hex> octet-stream .toda bytes → {colour: ..., trace: ...}
                                  (toda-rig-checker via interpreter.api)

   toda-bb runs in a SEPARATE JVM (clj/rigging_workshop/server_bb.clj on
   port 7879) because toda-bb and toda-core both define a `toda.shielding`
   namespace with incompatible signatures — co-loading them silently
   rebinds the vars and breaks both interpreters."
  (:require [twist-maker.core      :as core]
            [twist-maker.trdl      :as trdl]
            [twist-maker.decompile :as decompile]
            [lat.core              :as lat]
            [common.util           :as u]
            [atom.core             :as a]
            [atom.hash             :as h]
            [atom.packet           :as p]
            [store.core            :as store]
            [interpreter.api       :as interp]
            [interpreter.result    :as r]
            [interpreter.result.symbols :as sym]
            [clojure.data.json     :as json]
            [clojure.java.io       :as io]
            [clojure.string        :as str])
  (:import  [com.sun.net.httpserver HttpServer HttpHandler HttpExchange]
            [java.net InetSocketAddress]
            [java.io  ByteArrayInputStream ByteArrayOutputStream FileOutputStream File]
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

(defn- send-error! [^HttpExchange ex status reason]
  (let [payload (if (instance? Throwable reason)
                  (let [t ^Throwable reason
                        ed (ex-data t)]
                    (json/write-str (cond-> {:error true
                                             :type (.getName (.getClass t))
                                             :message (.getMessage t)}
                                      ed (assoc :data ed))))
                  (json/write-str {:error true
                                   :type "error"
                                   :message (str reason)}))]
    (send-response! ex status "application/json; charset=utf-8" payload)))

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
          {:keys [bytes twists corkline-h]} (core/build spec)
          line-hashes (mapv #(entity-hashes % twists) entities)
          payload  (json/write-str {:bytes      (b64 bytes)
                                    :lineHashes line-hashes
                                    :corkline   (when corkline-h
                                                  (str corkline-h))})]
      (send-response! ex 200 "application/json; charset=utf-8" payload))
    (catch Throwable t
      (.printStackTrace t)
      (send-error! ex 400 t))))

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
        (send-error! ex 400 t))
      (finally
        (.delete tmp)))))

(defn- parse-query [^String q]
  (when (and q (not (str/blank? q)))
    (into {} (for [pair (str/split q #"&")
                   :let [[k v] (str/split pair #"=" 2)]]
               [(keyword k) v]))))

(def ^:private inv-types   (into {} (map (fn [[k v]] [v k])) sym/types))
(def ^:private inv-colours (into {} (map (fn [[k v]] [v k])) sym/colours))
(def ^:private inv-issues  (into {} (map (fn [[k v]] [v k])) sym/issues))
(def ^:private inv-fields  (into {} (map (fn [[k v]] [v k])) sym/fields))

(defn- result-atom-fields
  "Decode a Result-shaped pairtrie atom into a {field-kw → value-hash} map."
  [result-atom]
  (let [content (-> result-atom a/packet p/pairtrie-content)]
    (reduce-kv (fn [acc key-h val-h]
                 (if-let [fk (get inv-fields key-h)]
                   (assoc acc fk val-h)
                   acc))
               {} content)))

(defn- issue->str [issue-kw]
  (-> issue-kw name str/upper-case))

(defn- atom->trace
  "Recursively convert a Result-shaped atom (resolved via atom-kvs) into a
   JSON-serializable trace tree {structype colour issue reference children}
   matching the canonical .json sidecar shape."
  [atom-kvs result-atom]
  (let [fields        (result-atom-fields result-atom)
        type-kw       (get inv-types   (:type   fields))
        colour-kw     (get inv-colours (:colour fields))
        issue-kw      (when-let [ih (:issue  fields)] (get inv-issues ih))
        ref-h         (:ref      fields)
        children-h    (:children fields)
        children-atom (when children-h (get atom-kvs children-h))
        children-kvs  (when children-atom
                        (-> children-atom a/packet p/pairtrie-content))
        children      (when (seq children-kvs)
                        (reduce-kv
                         (fn [acc type-h child-h]
                           (let [ck (get inv-types type-h)
                                 ca (get atom-kvs child-h)]
                             (cond-> acc
                               (and ck ca) (assoc (name ck)
                                                  (atom->trace atom-kvs ca)))))
                         {} children-kvs))]
    (cond-> {:structype (some-> type-kw   name)
             :colour    (some-> colour-kw name)}
      issue-kw       (assoc :issue (issue->str issue-kw))
      ref-h          (assoc :reference (str ref-h))
      (seq children) (assoc :children children))))

(defn result->trace
  "Convert a canonical rig-checker Result to a JSON-serializable trace tree."
  [^interpreter.result.Result result]
  (atom->trace (:atom-kvs result) (:atom result)))

(defn rigcheck-bytes
  "Run the canonical rig-checker over `.toda` bytes. Returns
   {:colour <\"red\"|\"yellow\"|\"green\">, :trace <tree>}.
   cork-hex required; twist-hex optional (defaults to focus of seeded bytes)."
  [^bytes bytes cork-hex twist-hex]
  (let [cork-h  (-> cork-hex u/hex->bytes h/from-bytes)
        store   (store/mutable-store)
        focus   (with-open [is (ByteArrayInputStream. bytes)]
                  (store/seed-from-input-stream! store is))
        twist-h (if twist-hex
                  (-> twist-hex u/hex->bytes h/from-bytes)
                  focus)
        result  (interp/interpret-rig store twist-h cork-h)]
    {:colour (name (r/colour result))
     :trace  (result->trace result)}))

(defn- handle-rigcheck
  "Run the canonical rig-checker over the .toda body. cork query param is
   required (hex hash). twist query param is optional; if omitted, we use
   the focus of the seeded bytes."
  [^HttpExchange ex]
  (try
    (let [bytes   (read-bytes ex)
          query   (parse-query (.getQuery (.getRequestURI ex)))
          out     (rigcheck-bytes bytes (:cork query) (:twist query))
          payload (json/write-str out)]
      (send-response! ex 200 "application/json; charset=utf-8" payload))
    (catch Throwable t
      (.printStackTrace t)
      (send-error! ex 400 t))))

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
      (send-error! ex 400 t))))

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
    (.createContext server "/rigcheck-clj" (make-handler handle-rigcheck))
    (.createContext server "/health"    (make-handler handle-health))
    (.createContext server "/spec"      (make-handler handle-spec))
    (.setExecutor server nil)
    (.start server)
    (println (str "rigging-workshop server on http://localhost:" PORT))))
